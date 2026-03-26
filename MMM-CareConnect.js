/* global Module */

Module.register("MMM-CareConnect", {
    defaults: {
        hubBasePath: "/mm-simple-remote",
        hubUrl: "",
        mirrorToken: "",
        deviceName: "",
        pollMs: 1000,
        stunServers: [{ urls: "stun:stun.l.google.com:19302" }],
        alertButtons: [
            { label: "Need help", message: "I need assistance.", level: "help" },
            { label: "Call me", message: "Please call me when you can.", level: "call" }
        ],
        showCallButton: true
    },

    start() {
        this.state = {
            status: "idle",
            info: "",
            lastError: "",
            lastAlertSentAt: 0,

            incoming: null, // { id, offer }
            sessionId: null,

            pc: null,
            localStream: null,
            iceSince: 0,
            pendingLocalIce: [],

            pollTimer: null,
            answerTimer: null,
            iceTimer: null
        };

        this._schedulePoll();
        this.updateDom(0);
    },

    getStyles() {
        return ["MMM-CareConnect.css"];
    },

    notificationReceived(notification, payload) {
        if (notification === "AUDIOCALL_START_REQUEST") this._startCall();
        if (notification === "AUDIOCALL_ACCEPT_REQUEST") this._acceptIncoming();
        if (notification === "AUDIOCALL_DECLINE_REQUEST") this._declineIncoming();
        if (notification === "AUDIOCALL_HANGUP_REQUEST") this._hangup("voice_hangup");
        if (notification === "CARE_ALERT_SEND" && payload && payload.message) {
            this._sendCareAlert(String(payload.message), payload.level || "help");
        }
    },

    getDom() {
        const root = document.createElement("div");
        root.className = "cc-root";

        const header = document.createElement("div");
        header.className = "cc-header";
        header.textContent = "Care";
        root.appendChild(header);

        const err = document.createElement("div");
        err.className = "cc-error";
        err.style.display = this.state.lastError ? "block" : "none";
        err.textContent = this.state.lastError || "";
        root.appendChild(err);

        const status = document.createElement("div");
        status.className = "cc-status";
        status.textContent = this._statusText();
        root.appendChild(status);

        const btnGrid = document.createElement("div");
        btnGrid.className = "cc-grid";

        (this.config.alertButtons || []).forEach((b) => {
            const btn = document.createElement("button");
            btn.className = "cc-btn cc-btn-alert";
            btn.textContent = b.label || "Alert";
            btn.onclick = () => this._sendCareAlert(b.message || "I need assistance.", b.level || "help");
            btnGrid.appendChild(btn);
        });

        if (this.config.showCallButton) {
            const callBtn = document.createElement("button");
            callBtn.className = "cc-btn cc-btn-call";
            callBtn.textContent = this.state.sessionId ? "Hang up" : "Call carer";
            callBtn.onclick = () => (this.state.sessionId ? this._hangup("mirror_hangup") : this._startCall());
            btnGrid.appendChild(callBtn);
        }

        root.appendChild(btnGrid);

        
        if (this.state.incoming && this.state.incoming.id) {
            const overlay = document.createElement("div");
            overlay.className = "cc-incoming";

            const t = document.createElement("div");
            t.className = "cc-incoming-title";
            t.textContent = "Incoming call";
            overlay.appendChild(t);

            const actions = document.createElement("div");
            actions.className = "cc-incoming-actions";

            const accept = document.createElement("button");
            accept.className = "cc-btn cc-btn-accept";
            accept.textContent = "Accept";
            accept.onclick = () => this._acceptIncoming();

            const decline = document.createElement("button");
            decline.className = "cc-btn cc-btn-decline";
            decline.textContent = "Decline";
            decline.onclick = () => this._declineIncoming();

            actions.appendChild(accept);
            actions.appendChild(decline);
            overlay.appendChild(actions);

            root.appendChild(overlay);
        }

       
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.className = "cc-audio";
        audio.id = "ccRemoteAudio";
        root.appendChild(audio);

        return root;
    },

    // --------- HTTP helpers ----------

    _hubBase() {
        const basePath = String(this.config.hubBasePath || "/mm-simple-remote").trim() || "/mm-simple-remote";
        const path = basePath.startsWith("/") ? basePath : `/${basePath}`;
        const hubUrl = String(this.config.hubUrl || "").trim();

        if (!hubUrl) return path.replace(/\/+$/, "");
        return `${hubUrl.replace(/\/+$/, "")}${path.replace(/\/+$/, "")}`;
    },

    async _mirrorFetch(path, opts) {
        const token = String(this.config.mirrorToken || "").trim();
        const url = `${this._hubBase()}${path}`;
        const headers = Object.assign({ "Content-Type": "application/json" }, (opts && opts.headers) || {});
        if (token) headers["X-Mirror-Token"] = token;

        const res = await fetch(url, Object.assign({
            method: "GET",
            headers
        }, opts || {}));

        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        return { ok: res.ok, status: res.status, json, raw: text };
    },

    _deviceName() {
        const fromCfg = String(this.config.deviceName || "").trim();
        if (fromCfg) return fromCfg;
        return (typeof window !== "undefined" && window.location && window.location.hostname) ? window.location.hostname : "mirror";
    },

    _setError(msg) {
        this.state.lastError = msg || "";
        this.updateDom(0);
    },

    _statusText() {
        if (this.state.incoming) return "Incoming call…";
        if (this.state.sessionId && this.state.status === "calling") return "Calling…";
        if (this.state.sessionId && this.state.status === "ringing") return "Ringing…";
        if (this.state.sessionId && this.state.status === "in_call") return "In call";
        return "Idle";
    },

    _schedulePoll() {
        if (this.state.pollTimer) clearInterval(this.state.pollTimer);
        this.state.pollTimer = setInterval(() => this._pollPending(), Math.max(500, this.config.pollMs || 1000));
    },

    async _pollPending() {
        try {
            if (this.state.sessionId) return; 
            const res = await this._mirrorFetch(`/api/mirror/rtc/pending?device=${encodeURIComponent(this._deviceName())}`);
            if (!res || !res.ok || !res.json) return;
            const items = Array.isArray(res.json.items) ? res.json.items : [];
            if (!items.length) {
                if (this.state.incoming) {
                    this.state.incoming = null;
                    this.updateDom(0);
                }
                return;
            }
            const first = items[0];
            if (!first || !first.id || !first.offer) return;
            if (this.state.incoming && this.state.incoming.id === first.id) return;

            this.state.incoming = { id: String(first.id), offer: first.offer };
            this._setError("");
        } catch (_) {
        } finally {
            this.updateDom(0);
        }
    },

    // --------- Care alerts ----------

    async _sendCareAlert(message, level) {
        try {
            this._setError("");
            const now = Date.now();
            if (now - this.state.lastAlertSentAt < 800) return;
            this.state.lastAlertSentAt = now;

            const res = await this._mirrorFetch("/api/mirror/care-alert", {
                method: "POST",
                body: JSON.stringify({
                    device: this._deviceName(),
                    message: String(message || "I need assistance."),
                    level: String(level || "help")
                })
            });

            if (!res.ok) {
                this._setError("Failed to send alert.");
                return;
            }
            this.state.info = "Alert sent ✓";
        } catch (e) {
            this._setError(`Alert failed: ${e && e.message ? e.message : String(e)}`);
        } finally {
            this.updateDom(0);
            setTimeout(() => { this.state.info = ""; this.updateDom(0); }, 2500);
        }
    },

    // --------- WebRTC ----------

    async _createPc() {
        const pc = new RTCPeerConnection({ iceServers: this.config.stunServers || [] });
        this.state.pc = pc;

        pc.ontrack = (evt) => {
            if (!evt || !evt.streams || !evt.streams[0]) return;
            const el = document.getElementById("ccRemoteAudio");
            if (!el) return;
            el.srcObject = evt.streams[0];
            try { el.play().catch(() => {}); } catch (_) {}
        };

        pc.onicecandidate = async (evt) => {
            if (!evt || !evt.candidate) return;

            if (!this.state.sessionId) {
                this.state.pendingLocalIce.push(evt.candidate);
                while (this.state.pendingLocalIce.length > 250) this.state.pendingLocalIce.shift();
                return;
            }

            await this._mirrorFetch(`/api/mirror/rtc/${encodeURIComponent(this.state.sessionId)}/ice`, {
                method: "POST",
                body: JSON.stringify({ candidate: evt.candidate })
            });
        };

        pc.onconnectionstatechange = () => {
            const s = pc.connectionState;
            if (s === "connected") this.state.status = "in_call";
            if (s === "failed" || s === "disconnected") this.state.status = "idle";
            this.updateDom(0);
        };

        return pc;
    },

    async _attachMicIfPossible(pc) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            this.state.localStream = stream;
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));
            return { ok: true, mic: true };
        } catch (_) {
            pc.addTransceiver("audio", { direction: "recvonly" });
            return { ok: true, mic: false };
        }
    },

    async _flushPendingIce() {
        if (!this.state.sessionId) return;
        const pending = Array.isArray(this.state.pendingLocalIce) ? this.state.pendingLocalIce : [];
        this.state.pendingLocalIce = [];
        for (const c of pending) {
            await this._mirrorFetch(`/api/mirror/rtc/${encodeURIComponent(this.state.sessionId)}/ice`, {
                method: "POST",
                body: JSON.stringify({ candidate: c })
            });
        }
    },

    async _startCall() {
        try {
            if (this.state.sessionId) return;
            this._setError("");

            this.state.status = "calling";
            this.updateDom(0);

            const pc = await this._createPc();
            await this._attachMicIfPossible(pc);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            const res = await this._mirrorFetch("/api/mirror/rtc/create", {
                method: "POST",
                body: JSON.stringify({
                    mode: "audio",
                    device: this._deviceName(),
                    sdp: pc.localDescription
                })
            });

            if (!res.ok || !res.json || !res.json.sessionId) {
                this._setError("Call start failed (hub).");
                await this._hangup("start_failed");
                return;
            }

            this.state.sessionId = String(res.json.sessionId);
            await this._flushPendingIce();

            this.state.status = "ringing";
            this._startAnswerPolling();
            this._startIcePolling();
        } catch (e) {
            this._setError(`Call failed: ${e && e.message ? e.message : String(e)}`);
            await this._hangup("start_exception");
        } finally {
            this.updateDom(0);
        }
    },

    async _acceptIncoming() {
        try {
            if (!this.state.incoming || !this.state.incoming.id || !this.state.incoming.offer) return;
            if (this.state.sessionId) return;

            this._setError("");
            this.state.sessionId = String(this.state.incoming.id);
            const offer = this.state.incoming.offer;
            this.state.incoming = null;

            this.state.status = "calling";
            this.updateDom(0);

            const pc = await this._createPc();
            await this._attachMicIfPossible(pc);

            await pc.setRemoteDescription(offer);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            const post = await this._mirrorFetch(`/api/mirror/rtc/${encodeURIComponent(this.state.sessionId)}/answer`, {
                method: "POST",
                body: JSON.stringify({ sdp: pc.localDescription })
            });

            if (!post.ok) {
                this._setError("Failed to answer (hub).");
                await this._hangup("answer_failed");
                return;
            }

            await this._flushPendingIce();
            this.state.status = "in_call";
            this._startIcePolling();
        } catch (e) {
            this._setError(`Answer failed: ${e && e.message ? e.message : String(e)}`);
            await this._hangup("answer_exception");
        } finally {
            this.updateDom(0);
        }
    },

    async _declineIncoming() {
        try {
            if (!this.state.incoming || !this.state.incoming.id) {
                this.state.incoming = null;
                this.updateDom(0);
                return;
            }

            await this._mirrorFetch(`/api/mirror/rtc/${encodeURIComponent(this.state.incoming.id)}/decline`, { method: "POST" });
        } catch (_) {}
        this.state.incoming = null;
        this.updateDom(0);
    },

    _startAnswerPolling() {
        if (this.state.answerTimer) clearInterval(this.state.answerTimer);
        this.state.answerTimer = setInterval(() => this._pollAnswer(), 900);
    },

    _startIcePolling() {
        if (this.state.iceTimer) clearInterval(this.state.iceTimer);
        this.state.iceTimer = setInterval(() => this._pollCarerIce(), 800);
    },

    async _pollAnswer() {
        try {
            if (!this.state.sessionId || !this.state.pc) return;
            if (this.state.status === "in_call") return;

            const res = await this._mirrorFetch(`/api/mirror/rtc/${encodeURIComponent(this.state.sessionId)}/answer`, { method: "GET" });
            if (!res.ok || !res.json) return;

            if (res.json.declinedAt || res.json.endedAt) {
                await this._hangup("remote_end");
                return;
            }

            if (res.json.answer && this.state.pc.signalingState !== "stable") {
                await this.state.pc.setRemoteDescription(res.json.answer);
                this.state.status = "in_call";
                this.updateDom(0);
            }
        } catch (_) {}
    },

    async _pollCarerIce() {
        try {
            if (!this.state.sessionId || !this.state.pc) return;

            const res = await this._mirrorFetch(
                `/api/mirror/rtc/${encodeURIComponent(this.state.sessionId)}/ice?since=${this.state.iceSince}&from=carer`,
                { method: "GET" }
            );
            if (!res.ok || !res.json) return;

            const items = Array.isArray(res.json.items) ? res.json.items : [];
            for (const it of items) {
                if (!it || !it.candidate) continue;
                try { await this.state.pc.addIceCandidate(it.candidate); } catch (_) {}
            }
            this.state.iceSince = Number(res.json.next || this.state.iceSince) || this.state.iceSince;
        } catch (_) {}
    },

    async _hangup(reason) {
        try {
            if (this.state.answerTimer) clearInterval(this.state.answerTimer);
            if (this.state.iceTimer) clearInterval(this.state.iceTimer);
            this.state.answerTimer = null;
            this.state.iceTimer = null;

            if (this.state.sessionId) {
                await this._mirrorFetch(`/api/mirror/rtc/${encodeURIComponent(this.state.sessionId)}/end`, {
                    method: "POST",
                    body: JSON.stringify({ reason: String(reason || "hangup") })
                });
            }
        } catch (_) {}

        try { if (this.state.pc) this.state.pc.close(); } catch (_) {}
        this.state.pc = null;

        if (this.state.localStream) {
            this.state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        }
        this.state.localStream = null;

        this.state.sessionId = null;
        this.state.iceSince = 0;
        this.state.pendingLocalIce = [];
        this.state.status = "idle";
        this.updateDom(0);
    }
});
