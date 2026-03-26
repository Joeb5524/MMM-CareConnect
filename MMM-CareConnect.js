/* global Module */
Module.register("MMM-CareConnect", {
    defaults: {
        header: "Care",

        // Hub connection
        hubBasePath: "/mm-simple-remote",
        hubUrl: "",              // e.g. "https://mirror.local:8080"
        mirrorToken: "",         // must match hub config.mirrorToken (or env SR_MIRROR_TOKEN)

        // Panels
        showAlerts: true,
        showCalling: true,

        // Alerts
        alertTransport: "http",  // "http" | "notification"
        alertTitle: "Mirror alert",
        alertButtons: [
            { label: "Need help", message: "I need assistance.", level: "help" },
            { label: "Call me", message: "Please call me when you can.", level: "call" }
        ],
        alertConfirmMs: 2500,

        // Calling
        pollIntervalMs: 1500,
        callButtonLabel: "Start audio call",
        hangupButtonLabel: "Hang up",
        answerTimeoutMs: 45000,
        stunServers: [{ urls: "stun:stun.l.google.com:19302" }],
        autoSendAlertOnCallFailure: true,
        autoBusyReject: true,
        ringtone: { enabled: true, intervalMs: 1200, toneHz: 880, toneMs: 180 }
    },

    start() {
        // Alert UI state
        this._alertStatus = { state: "idle", text: "" }; // idle|sending|sent|error

        // Call state
        this._callState = "idle"; // idle|creating|ringing|incoming|in_call|ending|error
        this._callStatusText = "";
        this._sessionId = null;
        this._incomingOffer = null;

        this._pc = null;
        this._localStream = null;
        this._remoteStream = null;
        this._remoteAudioEl = null;

        this._answerDeadlineAt = 0;
        this._pollTimer = null;
        this._answerPollTimer = null;
        this._icePollTimer = null;
        this._iceCarerIdx = 0;

        this._ringtoneTimer = null;
        this._audioCtx = null;

        if (this.config.showCalling) this._startIncomingPoll();
    },

    getStyles() {
        return ["MMM-CareConnect.css"];
    },

    notificationReceived(notification, payload) {
        if (notification === "SR_CARE_ALERT") {
            this._sendAlert({
                title: (payload && payload.title) || this.config.alertTitle,
                message: (payload && payload.message) || "Assistance requested from the mirror.",
                level: (payload && payload.level) || "help"
            });
            return;
        }

        // Voice control friendly calling.
        if (notification === "AUDIOCALL_START_REQUEST") {
            this._startOutgoing((payload && payload.reason) ? String(payload.reason) : "request");
            return;
        }
        if (notification === "AUDIOCALL_END_REQUEST") {
            this._endCall("ended_by_request");
            return;
        }
        if (notification === "AUDIOCALL_ACCEPT_REQUEST") {
            this._acceptIncoming((payload && payload.reason) ? String(payload.reason) : "request");
            return;
        }
        if (notification === "AUDIOCALL_DECLINE_REQUEST") {
            this._declineIncoming((payload && payload.reason) ? String(payload.reason) : "request");
            return;
        }
    },

    getDom() {
        const root = document.createElement("div");
        root.className = "mmm-careconnect";

        const header = document.createElement("div");
        header.className = "cc-header";
        header.textContent = String(this.config.header || "Care");
        root.appendChild(header);

        if (this.config.showAlerts) root.appendChild(this._renderAlertsPanel());
        if (this.config.showCalling) root.appendChild(this._renderCallingPanel());

        return root;
    },

    _renderAlertsPanel() {
        const panel = document.createElement("div");
        panel.className = "cc-panel";

        const title = document.createElement("div");
        title.className = "cc-panel__title";
        title.textContent = "Alerts";
        panel.appendChild(title);

        const btnRow = document.createElement("div");
        btnRow.className = "cc-row";

        (Array.isArray(this.config.alertButtons) ? this.config.alertButtons : []).forEach((btn) => {
            const b = document.createElement("button");
            b.className = "cc-btn";
            b.textContent = btn && btn.label ? String(btn.label) : "Alert";
            b.disabled = this._alertStatus.state === "sending";
            b.onclick = () => this._sendAlert({
                title: this.config.alertTitle,
                message: btn && btn.message ? String(btn.message) : "Assistance requested from the mirror.",
                level: btn && btn.level ? String(btn.level) : "help"
            });
            btnRow.appendChild(b);
        });

        panel.appendChild(btnRow);

        const status = document.createElement("div");
        status.className = "cc-status";
        status.textContent = this._alertStatus.text || "";
        panel.appendChild(status);

        return panel;
    },

    _renderCallingPanel() {
        const panel = document.createElement("div");
        panel.className = "cc-panel";

        const title = document.createElement("div");
        title.className = "cc-panel__title";
        title.textContent = "Audio call";
        panel.appendChild(title);

        const row = document.createElement("div");
        row.className = "cc-row";

        const callBtn = document.createElement("button");
        callBtn.className = "cc-btn";
        callBtn.textContent = String(this.config.callButtonLabel || "Start audio call");
        callBtn.disabled = !(this._callState === "idle" || this._callState === "error");
        callBtn.onclick = () => this._startOutgoing("button");
        row.appendChild(callBtn);

        const acceptBtn = document.createElement("button");
        acceptBtn.className = "cc-btn";
        acceptBtn.textContent = "Accept";
        acceptBtn.disabled = !(this._callState === "incoming");
        acceptBtn.onclick = () => this._acceptIncoming("button");
        row.appendChild(acceptBtn);

        const declineBtn = document.createElement("button");
        declineBtn.className = "cc-btn";
        declineBtn.textContent = "Decline";
        declineBtn.disabled = !(this._callState === "incoming");
        declineBtn.onclick = () => this._declineIncoming("button");
        row.appendChild(declineBtn);

        const hangupBtn = document.createElement("button");
        hangupBtn.className = "cc-btn";
        hangupBtn.textContent = String(this.config.hangupButtonLabel || "Hang up");
        hangupBtn.disabled = !(this._callState === "ringing" || this._callState === "in_call" || this._callState === "creating" || this._callState === "incoming");
        hangupBtn.onclick = () => this._endCall("hangup");
        row.appendChild(hangupBtn);

        panel.appendChild(row);

        const status = document.createElement("div");
        status.className = "cc-status";
        status.textContent = this._callStatusText || this._humanCallState(this._callState);
        panel.appendChild(status);

        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.controls = false;
        if (this._remoteStream) audio.srcObject = this._remoteStream;
        this._remoteAudioEl = audio;
        panel.appendChild(audio);

        return panel;
    },

    _hubBase() {
        const basePath = (this.config.hubBasePath || "/mm-simple-remote").startsWith("/")
            ? this.config.hubBasePath
            : `/${this.config.hubBasePath}`;

        if (this.config.hubUrl && typeof this.config.hubUrl === "string" && this.config.hubUrl.trim()) {
            return `${this.config.hubUrl.replace(/\/+$/, "")}${basePath}`;
        }

        const origin = window.location && window.location.origin ? window.location.origin : "";
        return `${origin}${basePath}`;
    },

    async _hubFetch(path, opts) {
        const headers = Object.assign({ "Content-Type": "application/json" }, (opts && opts.headers) || {});
        if (this.config.mirrorToken) headers["x-mirror-token"] = String(this.config.mirrorToken);

        const res = await fetch(`${this._hubBase()}${path}`, Object.assign({}, opts || {}, { headers }));
        const json = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, json };
    },

    // Alerts
    async _sendAlert(payload) {
        this._alertStatus = { state: "sending", text: "Sending…" };
        this.updateDom(0);

        try {
            if (this.config.alertTransport === "notification") {
                this.sendNotification("SR_CARE_ALERT", payload);
                this._alertStatus = { state: "sent", text: "Sent ✓" };
                this.updateDom(0);
                return this._autoClearAlert();
            }

            const res = await this._hubFetch("/api/mirror/care-alert", {
                method: "POST",
                body: JSON.stringify(payload)
            });

            if (!res.ok || !res.json || !res.json.ok) throw new Error("send_failed");

            this._alertStatus = { state: "sent", text: "Sent ✓" };
            this.updateDom(0);
            return this._autoClearAlert();
        } catch (e) {
            this._alertStatus = { state: "error", text: "Failed to send" };
            this.updateDom(0);
        }
    },

    _autoClearAlert() {
        setTimeout(() => {
            if (this._alertStatus.state === "sent") {
                this._alertStatus = { state: "idle", text: "" };
                this.updateDom(0);
            }
        }, Math.max(400, Number(this.config.alertConfirmMs) || 2500));
    },
    
    // Calling

    _humanCallState(state) {
        if (state === "idle") return "Ready";
        if (state === "creating") return "Starting…";
        if (state === "ringing") return "Calling…";
        if (state === "incoming") return "Incoming call";
        if (state === "in_call") return "In call";
        if (state === "ending") return "Ending…";
        if (state === "error") return "Error";
        return state;
    },

    _setCallState(state, statusText) {
        this._callState = state;
        if (typeof statusText === "string") this._callStatusText = statusText;
        this.updateDom(0);
    },

    _startIncomingPoll() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = setInterval(
            () => this._pollIncoming(),
            Math.max(700, Number(this.config.pollIntervalMs) || 1500)
        );
    },

    async _pollIncoming() {
        if (this._callState !== "idle") return;

        const res = await this._hubFetch("/api/mirror/rtc/pending", { method: "GET" });
        if (!res.ok || !res.json || !res.json.ok) return;

        const item = res.json.item;
        if (!item || !item.id || !item.offer) return;

        if (this.config.autoBusyReject && this._callState !== "idle") return;

        this._sessionId = String(item.id);
        this._incomingOffer = item.offer;
        this._setCallState("incoming", "Incoming call…");
        this._startRingtone();

        this._answerDeadlineAt = Date.now() + Math.max(5000, Number(this.config.answerTimeoutMs) || 45000);
        setTimeout(() => {
            if (this._callState === "incoming" && Date.now() >= this._answerDeadlineAt) {
                this._declineIncoming("timeout");
            }
        }, Math.max(800, Number(this.config.answerTimeoutMs) || 45000) + 50);
    },

    async _startOutgoing(reason) {
        if (!(this._callState === "idle" || this._callState === "error")) return;

        this._callStatusText = "";
        this._sessionId = null;
        this._incomingOffer = null;
        this._iceCarerIdx = 0;
        this._setCallState("creating", "Starting…");

        try {
            await this._createPeerConnection();

            const offer = await this._pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
            await this._pc.setLocalDescription(offer);

            const res = await this._hubFetch("/api/mirror/rtc/create", {
                method: "POST",
                body: JSON.stringify({ mode: "audio", offer: { type: offer.type, sdp: offer.sdp } })
            });

            if (!res.ok || !res.json || !res.json.ok || !res.json.sessionId) throw new Error("create_failed");

            this._sessionId = String(res.json.sessionId);
            this._setCallState("ringing", "Calling…");

            this._answerDeadlineAt = Date.now() + Math.max(5000, Number(this.config.answerTimeoutMs) || 45000);
            this._startAnswerPolling();
            this._startIcePolling();
        } catch (e) {
            await this._hardStopCall("start_failed");
            this._setCallState("error", "Call failed");

            if (this.config.autoSendAlertOnCallFailure) {
                this._sendAlert({
                    title: "Mirror call failed",
                    message: "Audio call failed to start.",
                    level: "call"
                });
            }
        }
    },

    async _acceptIncoming(reason) {
        if (this._callState !== "incoming" || !this._sessionId || !this._incomingOffer) return;
        this._stopRingtone();

        try {
            await this._createPeerConnection(true);

            await this._pc.setRemoteDescription(new RTCSessionDescription(this._incomingOffer));
            const answer = await this._pc.createAnswer();
            await this._pc.setLocalDescription(answer);

            const res = await this._hubFetch(`/api/mirror/rtc/${encodeURIComponent(this._sessionId)}/answer`, {
                method: "POST",
                body: JSON.stringify({ sdp: { type: answer.type, sdp: answer.sdp } })
            });
            if (!res.ok || !res.json || !res.json.ok) throw new Error("answer_failed");

            this._setCallState("in_call", "Connecting…");
            this._startIcePolling();
        } catch (e) {
            await this._hardStopCall("accept_failed");
            this._setCallState("error", "Failed to answer");
        }
    },

    async _declineIncoming(reason) {
        if (this._callState !== "incoming" || !this._sessionId) return;
        this._stopRingtone();

        await this._hubFetch(`/api/mirror/rtc/${encodeURIComponent(this._sessionId)}/decline`, {
            method: "POST",
            body: JSON.stringify({ reason: String(reason || "decline") })
        });

        await this._hardStopCall("declined");
        this._setCallState("idle", "Declined");
        setTimeout(() => this._setCallState("idle", ""), 1200);
    },

    async _endCall(reason) {
        if (!this._sessionId) {
            await this._hardStopCall(reason || "ended");
            this._setCallState("idle", "");
            return;
        }

        await this._hubFetch(`/api/mirror/rtc/${encodeURIComponent(this._sessionId)}/end`, {
            method: "POST",
            body: JSON.stringify({ reason: String(reason || "end") })
        });

        await this._hardStopCall(reason || "ended");
        this._setCallState("idle", "");
    },

    _startAnswerPolling() {
        if (this._answerPollTimer) clearInterval(this._answerPollTimer);

        this._answerPollTimer = setInterval(async () => {
            if (!this._sessionId || !(this._callState === "ringing" || this._callState === "creating")) return;

            if (Date.now() > this._answerDeadlineAt) {
                await this._endCall("timeout");
                this._setCallState("error", "No answer");
                return;
            }

            const res = await this._hubFetch(`/api/mirror/rtc/${encodeURIComponent(this._sessionId)}/answer`, { method: "GET" });
            if (!res.ok || !res.json || !res.json.ok) return;

            if (res.json.declinedAt || res.json.endedAt) {
                await this._endCall("declined");
                this._setCallState("error", "Declined");
                return;
            }

            if (!res.json.sdp) return;

            try {
                await this._pc.setRemoteDescription(new RTCSessionDescription(res.json.sdp));
                this._setCallState("in_call", "In call");
                clearInterval(this._answerPollTimer);
                this._answerPollTimer = null;
            } catch (e) {
                await this._endCall("bad_answer");
                this._setCallState("error", "Bad answer");
            }
        }, 1200);
    },

    _startIcePolling() {
        if (this._icePollTimer) clearInterval(this._icePollTimer);

        this._icePollTimer = setInterval(async () => {
            if (!this._sessionId || !this._pc) return;
            if (!(this._callState === "ringing" || this._callState === "incoming" || this._callState === "in_call" || this._callState === "creating")) return;

            const res = await this._hubFetch(
                `/api/mirror/rtc/${encodeURIComponent(this._sessionId)}/ice?since=${encodeURIComponent(String(this._iceCarerIdx))}`,
                { method: "GET" }
            );
            if (!res.ok || !res.json || !res.json.ok || !Array.isArray(res.json.items)) return;

            const items = res.json.items;
            const next = Number.isFinite(Number(res.json.next)) ? Number(res.json.next) : (this._iceCarerIdx + items.length);

            for (const c of items) {
                try {
                    await this._pc.addIceCandidate(new RTCIceCandidate(c));
                } catch (e) {
                    // ignore
                }
            }

            this._iceCarerIdx = Math.max(this._iceCarerIdx, next);
        }, 1000);
    },

    async _createPeerConnection(isIncoming) {
        await this._hardStopCall("recreate");

        const pc = new RTCPeerConnection({ iceServers: this.config.stunServers || [] });
        this._pc = pc;

        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            this._localStream = stream;
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));
            pc.addTransceiver("audio", { direction: "sendrecv" });
        } catch (e) {
            pc.addTransceiver("audio", { direction: "recvonly" });
        }

        pc.ontrack = (evt) => {
            if (!evt || !evt.streams || !evt.streams[0]) return;
            this._remoteStream = evt.streams[0];
            if (this._remoteAudioEl) this._remoteAudioEl.srcObject = this._remoteStream;
            if (this._callState === "in_call") this.updateDom(0);
        };

        pc.onicecandidate = async (evt) => {
            if (!evt || !evt.candidate || !this._sessionId) return;
            await this._hubFetch(`/api/mirror/rtc/${encodeURIComponent(this._sessionId)}/ice`, {
                method: "POST",
                body: JSON.stringify({ candidate: evt.candidate })
            });
        };

        pc.onconnectionstatechange = () => {
            const s = pc.connectionState;
            if (s === "connected" && this._callState !== "in_call") this._setCallState("in_call", "In call");
            if (s === "failed" || s === "disconnected") {
                if (this._callState !== "ending") this._setCallState("error", "Connection lost");
            }
        };
    },

    async _hardStopCall(reason) {
        this._stopRingtone();

        if (this._answerPollTimer) clearInterval(this._answerPollTimer);
        this._answerPollTimer = null;

        if (this._icePollTimer) clearInterval(this._icePollTimer);
        this._icePollTimer = null;

        if (this._pc) {
            try { this._pc.onicecandidate = null; this._pc.ontrack = null; } catch (e) {}
            try { this._pc.close(); } catch (e) {}
        }
        this._pc = null;

        if (this._localStream) {
            try { this._localStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        }
        this._localStream = null;

        this._remoteStream = null;
        if (this._remoteAudioEl) this._remoteAudioEl.srcObject = null;

        this._incomingOffer = null;
        this._sessionId = null;
        this._iceCarerIdx = 0;
    },

    _startRingtone() {
        if (!this.config.ringtone || !this.config.ringtone.enabled) return;
        this._stopRingtone();

        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            this._audioCtx = ctx;

            const tick = () => {
                if (!this._audioCtx) return;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.frequency.value = Number(this.config.ringtone.toneHz) || 880;
                gain.gain.value = 0.06;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                setTimeout(() => { try { osc.stop(); } catch (e) {} }, Math.max(60, Number(this.config.ringtone.toneMs) || 180));
            };

            tick();
            this._ringtoneTimer = setInterval(tick, Math.max(500, Number(this.config.ringtone.intervalMs) || 1200));
        } catch (e) {
            // ignore
        }
    },

    _stopRingtone() {
        if (this._ringtoneTimer) clearInterval(this._ringtoneTimer);
        this._ringtoneTimer = null;

        if (this._audioCtx) {
            try { this._audioCtx.close(); } catch (e) {}
        }
        this._audioCtx = null;
    }
});
