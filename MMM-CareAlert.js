/* global Module */

Module.register("MMM-CareAlert", {
    defaults: {
        header: "Carer",
        title: "Mirror alert",
        buttons: [
            { label: "Need help", message: "I need assistance." },
            { label: "Call me", message: "Please call me when you can." }
        ],
        ackTimeoutMs: 8000,
        confirmMs: 2500
    },

    start() {
        this._status = { state: "idle", text: "" };
        this._pendingRequestId = null;
        this._timeout = null;
    },

    getStyles() {
        return ["MMM-CareAlert.css"];
    },

    notificationReceived(notification, payload) {
        if (notification !== "SR_CARE_ALERT_STORED") return;
        const reqId = payload && payload.requestId ? String(payload.requestId) : null;
        if (!reqId || reqId !== this._pendingRequestId) return;

        this._clearPending();
        this._status = { state: "sent", text: "Sent ✓" };
        this.updateDom(0);

        setTimeout(() => {
            if (this._status.state === "sent") {
                this._status = { state: "idle", text: "" };
                this.updateDom(0);
            }
        }, Math.max(400, Number(this.config.confirmMs) || 2500));
    },

    _clearPending() {
        this._pendingRequestId = null;
        if (this._timeout) clearTimeout(this._timeout);
        this._timeout = null;
    },

    _send(btn) {
        const title = btn && btn.title ? String(btn.title) : String(this.config.title || "Mirror alert");
        const message = btn && btn.message ? String(btn.message) : "";

        this._clearPending();
        this._pendingRequestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this._status = { state: "sending", text: "Sending…" };
        this.updateDom(0);

        this.sendNotification("SR_CARE_ALERT", {
            title,
            message,
            level: "help",
            requestId: this._pendingRequestId
        });

        this._timeout = setTimeout(() => {
            if (!this._pendingRequestId) return;
            this._clearPending();
            this._status = { state: "error", text: "Not delivered (SimpleRemote missing?)" };
            this.updateDom(0);
        }, Math.max(1500, Number(this.config.ackTimeoutMs) || 8000));
    },

    getDom() {
        const wrap = document.createElement("div");
        wrap.className = "mmm-care";

        const buttons = Array.isArray(this.config.buttons) ? this.config.buttons : [];
        buttons.forEach((b) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "mmm-care__btn";
            btn.textContent = b && b.label ? String(b.label) : "Send";

            btn.onclick = () => this._send(b);
            btn.onkeydown = (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    btn.click();
                }
            };

            wrap.appendChild(btn);
        });

        const status = document.createElement("div");
        status.className = `mmm-care__status mmm-care__status--${this._status.state}`;
        status.textContent = this._status.text || "";
        wrap.appendChild(status);

        return wrap;
    }
});
