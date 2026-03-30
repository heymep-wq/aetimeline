const csInterface = new CSInterface();
let currentState = null;
let isPolling = false;
let pixelsPerSecond = 100;
let lastFastTime = null;

const ui = {
    compName: document.getElementById('ui-comp-name'),
    tracksList: document.getElementById('tracks-list'),
    tracksPanel: document.getElementById('tracks-panel'),
    playheadTop: document.getElementById('playhead-top'),
    playheadBody: document.getElementById('playhead-body'),
    playheadHead: document.querySelector('.playhead-head'),
    timeRuler: document.getElementById('time-ruler'),
    actionTips: document.getElementById('action-tips')
};

let lastInteractionTime = 0;
let lastNativeTime = 0;
let lastSyncTimestamp = 0;
let isPlaying = false;
let isDraggingPlayhead = false;

let pendingSetPlayheadCount = 0;
let pendingPlayTrigger = false;

// TUNE THIS: If our CSS playhead is reaching the end faster than AE's RAM preview,
// lower this multiplier (e.g. 0.95, 0.90) to mathematically slow down our 1.0x extrapolation.
let playbackSpeedMultiplier = 1.0;
let lastPlayStartTime = 0;

const TRIGGER_FILE = 'C:/Users/elastyo/AppData/Local/Temp/AEPlayTrigger.txt';

// Write trigger file for persistent AHK daemon (~15ms response)
function fireAETrigger() {
    csInterface.evalScript('var f = new File("' + TRIGGER_FILE + '"); f.open("w"); f.write("1"); f.close();');
    // Reclaim keyboard focus so spacebar keeps working for stop
    setTimeout(() => window.focus(), 50);
}

// Launch or ensure background AHK daemon is running
function launchAHKDaemon() {
    csInterface.evalScript('new File("C:/AETK/AEBridge/play_ae.exe").execute()');
}

const LabelColors = [
    "#b5b5b5", "#f9b7b7", "#f9e0b7", "#f9f9b7", "#c4f9b7", "#b7f9d5", "#b7f9f9", 
    "#b7d5f9", "#b7b7f9", "#d5b7f9", "#f9b7f9", "#f9b7d5", "#b59999", "#99b599", "#9999b5", "#b599b5", "#b5b599"
];

function init() {
    launchAHKDaemon();
    startSync();
    setupRuler();
    setupEvents();
}

function startSync() {
    if (isPolling) return;
    isPolling = true;

    const BRIDGE_FILE = 'C:/Users/elastyo/AppData/Local/Temp/AETimeBridge.txt';

    // Try every available file-read API in priority order
    let fileReader = null; // function() => string | null

    // Method 1: cep.fs (injected by CEP runtime)
    if (typeof cep !== 'undefined' && cep.fs) {
        const r = cep.fs.readFile(BRIDGE_FILE);
        if (r.err === 0) {
            fileReader = () => { const x = cep.fs.readFile(BRIDGE_FILE); return x.err === 0 ? x.data : null; };
        }
    }

    // Method 2: window.cep_node (--enable-nodejs)
    if (!fileReader && typeof window.cep_node !== 'undefined') {
        try {
            const fs = window.cep_node.require('fs');
            if (fs.existsSync(BRIDGE_FILE)) {
                fileReader = () => { try { return fs.readFileSync(BRIDGE_FILE, 'utf8'); } catch(e) { return null; } };
            }
        } catch(e) {}
    }

    // Method 3: global require (mixed-context)
    if (!fileReader && typeof require !== 'undefined') {
        try {
            const fs = require('fs');
            if (fs.existsSync(BRIDGE_FILE)) {
                fileReader = () => { try { return fs.readFileSync(BRIDGE_FILE, 'utf8'); } catch(e) { return null; } };
            }
        } catch(e) {}
    }



    // Web Worker drives 33ms ticks — immune to Chromium focus throttling
    const workerCode = `
        let tId, sId;
        self.onmessage = function(e) {
            if (e.data === 'start') {
                tId = setInterval(() => self.postMessage('fast'), 33);
                sId = setInterval(() => self.postMessage('full'), 300);
            }
        };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    let lastRawContent = '';

    worker.onmessage = function(e) {
        if (e.data === 'fast') {
            if (fileReader) {
                const raw = fileReader();
                if (raw !== null && raw !== '') {
                    const t = parseFloat(raw.trim());
                    const now = performance.now();

                    if (!isNaN(t) && currentState) {
                        const timeChanged = Math.abs(t - lastNativeTime) > 0.0001;
                        const stringChanged = raw !== lastRawContent;

                        if (timeChanged) {
                            lastRawContent = raw;
                            
                            if (isPlaying) {
                                // RAM Preview logic: ignore stale bridge time for 800ms after starting
                                const jump = Math.abs(t - currentState.time);
                                if (jump > 0.5) {
                                    const startingUp = (Date.now() - lastPlayStartTime < 800);
                                    if (!startingUp && pendingSetPlayheadCount === 0) {
                                        isPlaying = false;
                                        lastNativeTime = t;
                                        lastSyncTimestamp = now;
                                        
                                        if (t > currentState.time || (currentState.time - t > 0.2)) {
                                            updatePlayheadUI(t);
                                        }
                                    }
                                } else {
                                    // Good sync, keep extrapolator anchor updated
                                    lastNativeTime = t;
                                    lastSyncTimestamp = now;
                                }
                            } else {
                                // Not playing: Snap to bridge, but only if not in manual interaction cooldown
                                if (!isDraggingPlayhead && (Date.now() - lastInteractionTime > 400) && pendingSetPlayheadCount === 0) {
                                    lastNativeTime = t;
                                    lastSyncTimestamp = now;
                                    updatePlayheadUI(t);
                                }
                            }
                        } else if (stringChanged) {
                            lastRawContent = raw;
                            if (!isPlaying) {
                                lastSyncTimestamp = Math.floor(now);
                            }
                        }
                    }
                }
            } else {
                pollTimeFast();
            }
            if (isPlaying) extrapolatePlayhead();
        }
        if (e.data === 'full') pollStateFull();
    };
    worker.postMessage('start');
}

function pollTimeFast() {
    csInterface.evalScript("AELine.getFastTime()", (result) => {
        if (!result || result === "FAIL" || !currentState) return;
        const nTime = parseFloat(result);
        if (isNaN(nTime)) return;
        
        const now = performance.now();
        
        if (Math.abs(nTime - lastNativeTime) > 0.001) {
            let dtDelta = Math.abs(nTime - lastNativeTime);
            
            if (isPlaying) {
                // Durante playback, only allow major jumps (loops/stops) to move the seed.
                if (dtDelta > 0.5) {
                    const startingUp = (Date.now() - lastPlayStartTime < 800);
                    if (!startingUp && pendingSetPlayheadCount === 0) {
                        isPlaying = false;
                        lastNativeTime = nTime;
                        lastSyncTimestamp = now;
                        updatePlayheadUI(nTime);
                    }
                } else {
                    // Keep extrapolator anchor updated
                    lastNativeTime = nTime;
                    lastSyncTimestamp = now;
                }
            } else {
                // Not playing: Snap normally, but honor the interaction cooldown
                if (Date.now() - lastInteractionTime > 400 && pendingSetPlayheadCount === 0) {
                    lastNativeTime = nTime;
                    lastSyncTimestamp = now;
                    updatePlayheadUI(nTime);
                }
            }
        } else {
            // Evaluated explicitly as unchanged, natively paused
            if (!isPlaying && (now - lastSyncTimestamp > 300)) {
                updatePlayheadUI(nTime);
            }
        }
    });
}

function extrapolatePlayhead() {
    if (isPlaying && currentState) {
        let elapsed = ((performance.now() - lastSyncTimestamp) / 1000.0) * playbackSpeedMultiplier;
        let extTime = lastNativeTime + elapsed;
        
        // Loop: wrap around to beginning (mathematically, without modifying lastNativeTime)
        // so we don't break the worker's bridge tracking baseline.
        if (extTime > currentState.duration) {
            extTime = extTime % currentState.duration;
        }
        updatePlayheadUI(extTime);
    }
}

function updatePlayheadUI(timeVal) {
    currentState.time = timeVal;
    const playPx = timeVal * pixelsPerSecond;
    ui.playheadTop.style.transform = `translateX(${Math.round(playPx - ui.tracksPanel.scrollLeft)}px)`;
    ui.playheadBody.style.transform = `translateX(${Math.round(playPx)}px)`;
}

function pollStateFull() {
    if (Date.now() - lastInteractionTime < 400) return; // Debounce AE polling slightly during direct interaction
    csInterface.evalScript("AELine.getTimelineState()", (result) => {
        // Check again! If user interacted WHILE ExtendScript was evaluating, this data is stale.
        if (Date.now() - lastInteractionTime < 400) return; 
        
        try {
            if (!result || result === "undefined" || result === "") return;
            const data = JSON.parse(result);
            if (data.error) {
                ui.compName.innerText = data.error;
                clearUI();
            } else {
                updateUI(data);
            }
        } catch(e) {
            ui.compName.innerText = result ? result.substring(0, 50) : "Parse Error";
        }
    });
}

function clearUI() {
    ui.tracksList.innerHTML = '<div id="playhead-body"><div class="playhead-line"></div></div>';
    ui.playheadBody = document.getElementById('playhead-body');
    drawRuler(0, 30);
}

function updateUI(state) {
    if (!currentState || currentState.id !== state.id) {
        ui.compName.innerText = state.name;
    }
    
    // Static Playhead Update (Only overwrite if not actively animating via Extrapolator)
    if (!isPlaying) {
        const playPx = state.time * pixelsPerSecond;
        ui.playheadTop.style.transform = `translateX(${Math.round(playPx - ui.tracksPanel.scrollLeft)}px)`;
        ui.playheadBody.style.transform = `translateX(${Math.round(playPx)}px)`;
    }
    
    // Bounds limit for timeline width match precisely matched to Comp bounds
    ui.tracksList.style.width = Math.max(ui.tracksPanel.clientWidth, state.duration * pixelsPerSecond) + 'px';
    
    if (needsFullRebuild(currentState, state)) {
        rebuildLayers(state);
    } else {
        updateLayers(state);
    }
    
    drawRuler(state.duration, state.frameRate);
    updateActionTips(state);
    currentState = state;
}

function needsFullRebuild(oldState, newState) {
    if (!oldState) return true;
    if (oldState.layers.length !== newState.layers.length) return true;
    for (let i = 0; i < oldState.layers.length; i++) {
        const o = oldState.layers[i];
        const n = newState.layers[i];
        if (o.index !== n.index || o.keyframes.length !== n.keyframes.length) return true;
    }
    return false;
}

function rebuildLayers(state) {
    ui.tracksList.innerHTML = '<div id="playhead-body"><div class="playhead-line"></div></div>';
    ui.playheadBody = document.getElementById('playhead-body');
    
    state.layers.forEach(layer => {
        const trackDiv = document.createElement("div");
        trackDiv.className = "track-item";
        trackDiv.dataset.index = layer.index;
        if(layer.selected) trackDiv.classList.add("selected");
        
        const layerBar = document.createElement("div");
        layerBar.className = "layer-bar";
        if(layer.selected) layerBar.classList.add("selected");
        layerBar.style.backgroundColor = LabelColors[layer.label] || LabelColors[0];
        
        if(layer.animP) layerBar.innerHTML += `<div class="prop-badge">P</div>`;
        if(layer.animS) layerBar.innerHTML += `<div class="prop-badge">S</div>`;
        if(layer.animR) layerBar.innerHTML += `<div class="prop-badge">R</div>`;
        if(layer.animO) layerBar.innerHTML += `<div class="prop-badge">O</div>`;
        
        trackDiv.appendChild(layerBar);
        
        layer.keyframes.forEach(kfTime => {
            const kf = document.createElement("div");
            kf.className = "keyframe";
            kf.style.left = (kfTime * pixelsPerSecond) + "px";
            trackDiv.appendChild(kf);
        });
        
        layerBar.onmousedown = (e) => {
            if (e.button !== 0) return;
            
            // Stop playback if dragging/clicking layers while playing
            if (isPlaying) {
                isPlaying = false;
                fireAETrigger();
            }
            
            const startX = e.pageX;
            const baseStart = layer.startTime;
            
            // Handle Adobe standard selection
            lastInteractionTime = Date.now();
            if (!e.shiftKey && !e.ctrlKey) {
                if (currentState) currentState.layers.forEach(l => l.selected = false);
                document.querySelectorAll('.track-item').forEach(el => el.classList.remove('selected'));
                document.querySelectorAll('.layer-bar').forEach(el => el.classList.remove('selected'));
                trackDiv.classList.add('selected');
                layerBar.classList.add('selected');
                if (currentState) {
                    const match = currentState.layers.find(l => l.index === layer.index);
                    if (match) match.selected = true;
                }
                csInterface.evalScript(`AELine.selectLayer("${layer.index}", "true")`);
            } else {
                if (currentState) {
                    const match = currentState.layers.find(l => l.index === layer.index);
                    if (match) match.selected = !match.selected;
                }
                trackDiv.classList.toggle('selected');
                layerBar.classList.toggle('selected');
                csInterface.evalScript(`AELine.selectLayer("${layer.index}", "false")`);
            }
            updateActionTips(currentState);
            
            const moveHandler = (moveEvent) => {
                lastInteractionTime = Date.now();
                const dy = moveEvent.pageY - e.pageY;
                // Interaction mock: Alt-drag handles rippling natively
                const dx = moveEvent.pageX - startX;
                layerBar.style.left = ((baseStart + (dx / pixelsPerSecond)) * pixelsPerSecond) + "px";
            };
            const upHandler = (upEvent) => {
                lastInteractionTime = Date.now();
                document.removeEventListener("mousemove", moveHandler);
                document.removeEventListener("mouseup", upHandler);
                const dx = upEvent.pageX - startX;
                const newStart = baseStart + (dx / pixelsPerSecond);
                csInterface.evalScript(`AELine.setLayerTime("${layer.index}", "null", "null", "${newStart}")`);
            };
            document.addEventListener("mousemove", moveHandler);
            document.addEventListener("mouseup", upHandler);
        };
        
        ui.tracksList.appendChild(trackDiv);
        updateLayerNode(trackDiv, layerBar, layer);
    });
    
    // Keep playhead line on top
    ui.tracksList.appendChild(ui.playheadBody);
}

function updateLayers(state) {
    const trackItems = document.querySelectorAll("#tracks-list .track-item");
    state.layers.forEach((layer, idx) => {
        if (!trackItems[idx]) return;
        const layerBar = trackItems[idx].querySelector(".layer-bar");
        
        if (layer.selected) {
            trackItems[idx].classList.add("selected");
            layerBar.classList.add("selected");
        } else {
            trackItems[idx].classList.remove("selected");
            layerBar.classList.remove("selected");
        }
        
        updateLayerNode(trackItems[idx], layerBar, layer);
        const kfs = trackItems[idx].querySelectorAll(".keyframe");
        layer.keyframes.forEach((kfTime, kidx) => {
            if (kfs[kidx]) kfs[kidx].style.left = (kfTime * pixelsPerSecond) + "px";
        });
    });
}

function updateLayerNode(trackDiv, layerBar, layer) {
    layerBar.style.left = (layer.inPoint * pixelsPerSecond) + "px";
    layerBar.style.width = ((layer.outPoint - layer.inPoint) * pixelsPerSecond) + "px";
}

function updateActionTips(state) {
    const selLayers = state.layers.filter(l => l.selected);
    const selCount = selLayers.length;
    
    if (selCount === 0) {
        ui.actionTips.style.display = "none";
    } else {
        ui.actionTips.style.display = "flex";
        ui.actionTips.innerHTML = "";
        
        let header = document.createElement("div");
        header.style.color = "#aaa";
        header.style.marginRight = "6px";
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.innerText = selCount === 1 ? `[${selLayers[0].index}] Edit:` : `${selCount} Selected:`;
        ui.actionTips.appendChild(header);
        
        let actions = [];
        if (selCount === 1) {
            actions = ["Ripple Trim", "Swap Timing", "Extract Keys"];
        } else {
            actions = ["Smart Precompose", "Equal Distribute", "Link Anchor"];
        }
        actions.forEach(a => {
            let btn = document.createElement("div");
            btn.className = "tip-btn";
            btn.innerText = a;
            btn.onclick = () => alert("Action triggered: " + a);
            ui.actionTips.appendChild(btn);
        });
    }
}

function drawRuler(duration, fps) {
    const c = ui.timeRuler;
    const rightPanel = document.getElementById('header-right');
    c.width = rightPanel.clientWidth;
    c.height = rightPanel.clientHeight;
    
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    
    const viewSecs = c.width / pixelsPerSecond;
    const scrollSecs = ui.tracksPanel.scrollLeft / pixelsPerSecond;
    
    ctx.beginPath();
    ctx.moveTo(0, c.height - 0.5);
    ctx.lineTo(c.width, c.height - 0.5);
    ctx.strokeStyle = "#4CAF50";
    ctx.stroke();

    ctx.strokeStyle = "#444";
    ctx.fillStyle = "#999";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    let tStep = 1;
    if (pixelsPerSecond < 50) tStep = 5;
    if (pixelsPerSecond < 10) tStep = 15;
    if (pixelsPerSecond < 2) tStep = 60;
    
    let startT = Math.floor(scrollSecs / tStep) * tStep;
    
    for (let t = startT; t < scrollSecs + viewSecs && t <= duration; t += tStep) {
        const x = (t - scrollSecs) * pixelsPerSecond;
        ctx.beginPath();
        ctx.moveTo(x, c.height - 8);
        ctx.lineTo(x, c.height);
        ctx.stroke();
        ctx.fillText(t + "s", x, c.height - 14);
    }
}

function setupRuler() {
    ui.tracksPanel.onscroll = () => {
        if (currentState) {
            drawRuler(currentState.duration, currentState.frameRate);
            const playPx = currentState.time * pixelsPerSecond;
            ui.playheadTop.style.transform = `translateX(${Math.round(playPx - ui.tracksPanel.scrollLeft)}px)`;
        }
    };
    
    let lastPlayheadSend = 0;
    
    const scrub = (e, immediate = false, silent = false) => {
        const wasPlaying = isPlaying;
        if (isPlaying) {
            isPlaying = false;
        }
        
        lastInteractionTime = Date.now();
        const rect = document.getElementById('header-right').getBoundingClientRect();
        const x = Math.max(0, e.clientX - rect.left + ui.tracksPanel.scrollLeft);
        let t = x / pixelsPerSecond;
        
        if (currentState && currentState.frameRate) {
            const fr = currentState.frameRate || 30;
            t = Math.round(t * fr) / fr;
            t = Math.min(t, currentState.duration);
        }
        
        updatePlayheadUI(t);
        lastNativeTime = t;
        lastSyncTimestamp = performance.now();

        if (!silent && (immediate || Date.now() - lastPlayheadSend > 33)) {
            lastPlayheadSend = Date.now();
            pendingSetPlayheadCount++;
            
            // Only fire AE trigger to pause if we were ACTUALLY playing. 
            // We do this immediately rather than waiting for the click events so that scrubbing interrupts safely.
            if (wasPlaying) {
                fireAETrigger();
            }
            
            csInterface.evalScript(`AELine.setPlayhead(${t})`, () => {
                pendingSetPlayheadCount--;
                if (pendingSetPlayheadCount === 0 && pendingPlayTrigger) {
                    pendingPlayTrigger = false;
                    isPlaying = true; // Make sure state gets set to playing before trigger!
                    if (currentState) lastNativeTime = currentState.time;
                    lastSyncTimestamp = performance.now();
                    lastPlayStartTime = Date.now();
                    fireAETrigger();
                }
            });
        }
        return t;
    };
    
    ui.timeRuler.onmousedown = (e) => {
        if (e.button !== 0) return;
        
        isDraggingPlayhead = true;
        scrub(e, true);
        const move = (ev) => scrub(ev);
        const up = (ev) => {
            isDraggingPlayhead = false;
            lastInteractionTime = Date.now();
            scrub(ev, true);
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };
    
    ui.playheadHead.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;

        isDraggingPlayhead = true;
        e.stopPropagation();
        scrub(e, true);
        const move = (ev) => scrub(ev);
        const up = (ev) => {
            isDraggingPlayhead = false;
            lastInteractionTime = Date.now();
            scrub(ev, true);
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
    
    ui.tracksPanel.addEventListener('mousedown', (e) => {
        if (e.target.closest('.track-item') || e.target.closest('#time-ruler') || e.target.closest('#playhead-top') || e.target.closest('#playhead-body')) return;
        
        if (e.button !== 0) return;
        
        // Stop playback if clicking empty space while playing
        if (isPlaying) {
            isPlaying = false;
            fireAETrigger();
        }
        
        lastInteractionTime = Date.now();
        if (currentState) {
            currentState.layers.forEach(l => l.selected = false);
            updateActionTips(currentState);
        }
        document.querySelectorAll('.track-item').forEach(el => el.classList.remove('selected'));
        document.querySelectorAll('.layer-bar').forEach(el => el.classList.remove('selected'));
        csInterface.evalScript('AELine.selectLayer("-1", "true")');
    });
}

function setupEvents() {
    ui.tracksPanel.addEventListener('wheel', (e) => {
        if(e.altKey) {
            e.preventDefault();
            pixelsPerSecond *= (e.deltaY > 0 ? 0.8 : 1.25);
            if(currentState && currentState.duration > 0) {
                const minZoom = ui.tracksPanel.clientWidth / currentState.duration;
                pixelsPerSecond = Math.max(minZoom, Math.min(1000, pixelsPerSecond));
                // Keep scaled width synchronized natively
                ui.tracksList.style.width = (currentState.duration * pixelsPerSecond) + 'px';
                updateUI(currentState);
            }
        }
    }, {passive: false});

    // Spacebar Trap for RAM Preview + UI Playhead Extrapolation
    let lastSpacebarTime = 0;
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName.toLowerCase() === 'input') return;
        
        if (e.code === 'Space') {
            e.preventDefault();
            e.stopPropagation();
            
            // Debounce: ignore rapid double-presses (race condition with trigger file)
            const now = Date.now();
            if (now - lastSpacebarTime < 200) return;
            lastSpacebarTime = now;
            
            isPlaying = !isPlaying;
            
            if (isPlaying) {
                if (currentState) {
                    lastNativeTime = currentState.time;
                }
                lastSyncTimestamp = performance.now();
                lastPlayStartTime = now;
            }
            
            if (pendingSetPlayheadCount > 0) {
                pendingPlayTrigger = !pendingPlayTrigger;
                // Don't fire AE trigger yet, but DO update our isPlaying state prediction!
                if (pendingPlayTrigger) {
                    isPlaying = true;
                    if (currentState) {
                        lastNativeTime = currentState.time;
                    }
                    lastSyncTimestamp = performance.now();
                    lastPlayStartTime = now;
                }
            } else {
                fireAETrigger();
            }
        }
    });
}

// Global UI Fixes: Stop middle-click autoscroll and other browser behaviors
document.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
}, true);

init();
