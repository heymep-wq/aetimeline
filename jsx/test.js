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

                for (var p = 1; p <= transform.numProperties; p++) {
                        var prop = transform.property(p);
                        try {
                            if (prop.propertyType === PropertyType.PROPERTY && prop.canVaryOverTime && prop.numKeys > 0) {
                                for (var k = 1; k <= prop.numKeys; k++) {
                                    lData.keyframes.push(prop.keyTime(k));
                                }
                            }
                        } catch(propErr) {}
                    }
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
            comp.time = parseFloat(tStr);
            return "OK";
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
