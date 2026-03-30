var AELine = {};

AELine.escapeStr = function(str) {
    if (!str) return '""';
    return '"' + str.toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
};

AELine.toJSON = function(obj) {
    if (obj === null) return "null";
    if (typeof obj === "undefined") return "null";
    if (typeof obj === "number" || typeof obj === "boolean") return obj.toString();
    if (typeof obj === "string") return AELine.escapeStr(obj);
    if (obj instanceof Array) {
        var arr = [];
        for (var i = 0; i < obj.length; i++) {
            arr.push(AELine.toJSON(obj[i]));
        }
        return "[" + arr.join(",") + "]";
    }
    if (typeof obj === "object") {
        var parts = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                parts.push(AELine.escapeStr(k) + ":" + AELine.toJSON(obj[k]));
            }
        }
        return "{" + parts.join(",") + "}";
    }
    return '""';
};


AELine.getTimelineState = function() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return AELine.toJSON({ error: "No active composition" });
        }
        
        var state = {
            id: comp.id,
            name: comp.name,
            duration: comp.duration,
            time: comp.time,
            frameRate: comp.frameRate,
            layers: []
        };
        
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            var lData = {
                index: layer.index,
                name: layer.name,
                startTime: layer.startTime,
                inPoint: layer.inPoint,
                outPoint: layer.outPoint,
                shy: layer.shy,
                solo: layer.solo,
                locked: layer.locked,
                enabled: layer.enabled,
                label: layer.label,
                selected: layer.selected,
                keyframes: [],
                animP: false, animS: false, animR: false, animO: false
            };
            
            var transform = layer.transform;
            if (transform) {
                try { lData.animP = transform.property("ADBE Position").numKeys > 0; } catch(e){}
                try { lData.animS = transform.property("ADBE Scale").numKeys > 0; } catch(e){}
                try { lData.animR = transform.property("ADBE Rotate Z").numKeys > 0; } catch(e){}
                try { lData.animO = transform.property("ADBE Opacity").numKeys > 0; } catch(e){}

                // Skip deeper keyframe traversal for performance
                // We'll rely exclusively on the P/S/R/O badges for now until viewport-bound tracking is created.
                }
                // Remove duplicates
                lData.keyframes = AELine.uniqueArray(lData.keyframes);
                
                state.layers.push(lData);
            }
            return AELine.toJSON(state);
        } catch(e) {
            return AELine.toJSON({ error: "[" + (e.line || "unknown") + "] " + e.toString() });
        }
    };

AELine.uniqueArray = function(arr) {
    if (arr.length === 0) return [];
    arr.sort(function(a, b) { return a - b; });
    var ret = [arr[0]];
    for (var i = 1; i < arr.length; i++) {
        // approx match because floats
        if (Math.abs(arr[i] - arr[i-1]) > 0.0001) {
            ret.push(arr[i]);
        }
    }
    return ret;
};

AELine.setPlayhead = function(tStr) {
    try {
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            var targetTime = parseFloat(tStr);
            
            // Clamp to valid range to prevent false mismatch
            if (targetTime < 0) targetTime = 0;
            if (targetTime > comp.duration) targetTime = comp.duration;
            
            comp.time = targetTime;
            
            // If the time didn't stick, it means AE is actively playing RAM preview.
            // We must pause it to force the playhead to the new position.
            if (Math.abs(comp.time - targetTime) > 0.01) {
                var cmd = app.findMenuCommandId('Play/Stop') || 2024;
                app.executeCommand(cmd); // Pause
                comp.time = targetTime; // Apply time now that it's paused
            }
            return "OK";
        }
    } catch(e) {}
    return "FAIL";
};

AELine.getFastTime = function() {
    try {
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            return comp.time.toString();
        }
    } catch(e) {}
    return "FAIL";
};

AELine.toggleLayerSwitch = function(indexStr, propName) {
    try {
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            var layer = comp.layer(parseInt(indexStr));
            if (layer) {
                if (propName === 'shy') layer.shy = !layer.shy;
                if (propName === 'solo') layer.solo = !layer.solo;
                if (propName === 'locked') layer.locked = !layer.locked;
                if (propName === 'enabled') layer.enabled = !layer.enabled;
            }
        }
        return "OK";
    }catch(e){return "FAIL";}
};

AELine.selectLayer = function(indexStr, exclusive) {
    try {
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            var idx = parseInt(indexStr);
            var target = null;
            if (idx >= 1 && idx <= comp.numLayers) {
                target = comp.layer(idx);
            }
            if (exclusive === "true") {
                for(var i = 1; i <= comp.numLayers; i++) {
                    comp.layer(i).selected = false;
                }
                if (target) target.selected = true;
            } else {
                if (target) target.selected = !target.selected;
            }
        }
        return "OK";
    } catch(e) { return "FAIL"; }
};

AELine.playPreview = function() {
    try {
        var str = "var cmd = app.findMenuCommandId('Play/Stop') || 2024; app.executeCommand(cmd);";
        app.scheduleTask(str, 150, false);
        return "OK";
    } catch(e) { 
        return "FAIL";
    }
};

AELine.setLayerTime = function(indexStr, inPointStr, outPointStr, startStr) {
    try {
        app.beginUndoGroup("Move Layer in AE Timeline Clone");
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            var layer = comp.layer(parseInt(indexStr));
            if (layer) {
                if (startStr !== "null") layer.startTime = parseFloat(startStr);
                if (inPointStr !== "null") layer.inPoint = parseFloat(inPointStr);
                if (outPointStr !== "null") layer.outPoint = parseFloat(outPointStr);
            }
        }
        app.endUndoGroup();
        return "OK";
    }catch(e){return e.toString();}
};

AELine.createSolid = function(nameStr, wStr, hStr, hexColor) {
    try {
        app.beginUndoGroup("New Solid");
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            // Convert hex to array
            hexColor = hexColor.replace("#", "");
            var r = parseInt(hexColor.substr(0, 2), 16) / 255;
            var g = parseInt(hexColor.substr(2, 2), 16) / 255;
            var b = parseInt(hexColor.substr(4, 2), 16) / 255;
            comp.layers.addSolid([r, g, b], nameStr, parseInt(wStr), parseInt(hStr), 1, comp.duration);
        }
        app.endUndoGroup();
        return "OK";
    }catch(e){return "FAIL";}
};

AELine.createNull = function() {
    try {
        app.beginUndoGroup("New Null");
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            comp.layers.addNull(comp.duration);
        }
        app.endUndoGroup();
        return "OK";
    }catch(e){return "FAIL";}
};
