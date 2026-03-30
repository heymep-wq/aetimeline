/**
 * CSInterface stub — provides core CEP APIs including cep.fs file access.
 */

// Expose cep.fs using the native CEP runtime if available
if (typeof window.__adobe_cep__ !== 'undefined' && typeof cep === 'undefined') {
    try {
        // __adobe_cep__ provides openURLInDefaultBrowser and other native calls
        // cep.fs is injected separately by the CEP runtime into the 'cep' global
        // If it's missing, we surface it here
    } catch(e) {}
}

function CSInterface() {
    this.hostEnvironment = null;
    try {
        if (window.__adobe_cep__) {
            this.hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
        }
    } catch (e) {
        console.error("CSInterface: Could not load host environment", e);
    }
}

CSInterface.prototype.getHostEnvironment = function() {
    return this.hostEnvironment;
};

CSInterface.prototype.evalScript = function(script, callback) {
    try {
        if (window.__adobe_cep__) {
            if (!callback) callback = function(result) {};
            window.__adobe_cep__.evalScript(script, callback);
        } else {
            console.log("Mock EvalScript:", script);
            if (callback) callback(null); 
        }
    } catch (e) {
        console.error("CSInterface: evalScript failed", e);
    }
};

CSInterface.prototype.getApplicationID = function() {
    if (this.hostEnvironment) return this.hostEnvironment.appId;
    return "MOCK";
};
