// device-fingerprint.js — lightweight device & browser fingerprint
//
// Generates:
//   - device_id: persistent UUID v4 stored in localStorage
//   - browser_hash: djb2 hash of stable, non-PII browser characteristics
//
// No external library. All fields collected here are non-invasive
// (userAgent, language, platform, screen size, timezone offset).

(function (global) {
    'use strict';

    const STORAGE_KEY = 'albedu_device_id';

    function generateUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers.
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    function getOrCreateDeviceId() {
        try {
            let deviceId = localStorage.getItem(STORAGE_KEY);
            if (!deviceId) {
                deviceId = generateUUID();
                localStorage.setItem(STORAGE_KEY, deviceId);
            }
            return deviceId;
        } catch (e) {
            // localStorage throws in Safari Private Mode and friends — fall
            // back to a session-only ID so the rest of the flow can continue.
            console.warn('[DeviceFingerprint] localStorage unavailable, using session-only device ID');
            return generateUUID();
        }
    }

    function generateBrowserHash() {
        const components = [];

        if (typeof navigator !== 'undefined') {
            components.push(navigator.userAgent || '');
            components.push(navigator.language || '');
            components.push(navigator.platform || '');
        }
        if (typeof screen !== 'undefined') {
            components.push(`${screen.width}x${screen.height}`);
        }
        components.push(String(new Date().getTimezoneOffset()));

        const combined = components.join('|');
        return simpleHash(combined);
    }

    function getDeviceInfo() {
        const info = {};

        if (typeof navigator !== 'undefined') {
            info.platform = navigator.platform || null;
            info.vendor = navigator.vendor || null;

            const ua = navigator.userAgent || '';
            if (ua.includes('Firefox')) {
                info.browser = 'Firefox';
            } else if (ua.includes('Edg')) {
                info.browser = 'Edge';
            } else if (ua.includes('Chrome')) {
                info.browser = 'Chrome';
            } else if (ua.includes('Safari')) {
                info.browser = 'Safari';
            } else {
                info.browser = 'Unknown';
            }
        }

        if (typeof screen !== 'undefined') {
            info.screen = `${screen.width}x${screen.height}`;
        }

        return info;
    }

    // djb2 — returns 8-char hex string.
    function simpleHash(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function getFingerprint() {
        return {
            device_id: getOrCreateDeviceId(),
            browser_hash: generateBrowserHash(),
            device_info: getDeviceInfo()
        };
    }

    function resetDeviceId() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {
            // Ignore — already absent or storage disabled.
        }
    }

    global.DeviceFingerprint = {
        getFingerprint: getFingerprint,
        getDeviceId: getOrCreateDeviceId,
        getBrowserHash: generateBrowserHash,
        resetDeviceId: resetDeviceId
    };

})(typeof window !== 'undefined' ? window : this);
