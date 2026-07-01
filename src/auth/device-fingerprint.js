// DeviceFingerprint.js — Lightweight device and browser fingerprinting
// Phase 1: Shadow Collection Only (NO enforcement, NO blocking)
// 
// Generates:
//   - device_id: Persistent UUID v4 stored in localStorage
//   - browser_hash: Lightweight hash of browser characteristics
//
// This module does NOT use FingerprintJS or any external library.

(function (global) {
    'use strict';

    const STORAGE_KEY = 'albedu_device_id';

    /**
     * Generate a RFC4122 compliant UUID v4
     */
    function generateUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    /**
     * Get or create persistent device ID
     * Stored in localStorage to persist across page reloads
     */
    function getOrCreateDeviceId() {
        try {
            let deviceId = localStorage.getItem(STORAGE_KEY);
            if (!deviceId) {
                deviceId = generateUUID();
                localStorage.setItem(STORAGE_KEY, deviceId);
            }
            return deviceId;
        } catch (e) {
            // localStorage not available (private browsing, disabled, etc.)
            // Generate a session-only ID
            console.warn('[DeviceFingerprint] localStorage unavailable, using session-only device ID');
            return generateUUID();
        }
    }

    /**
     * Generate lightweight browser hash
     * Combines stable browser characteristics into a single hash string
     * 
     * Components (all non-PII, privacy-friendly):
     *   - navigator.userAgent
     *   - navigator.language
     *   - navigator.platform
     *   - screen.width x screen.height
     *   - timezone offset
     */
    function generateBrowserHash() {
        const components = [];

        // Navigator properties (only essential, non-invasive fields)
        if (typeof navigator !== 'undefined') {
            components.push(navigator.userAgent || '');
            components.push(navigator.language || '');
            components.push(navigator.platform || '');
        }

        // Screen properties (resolution only)
        if (typeof screen !== 'undefined') {
            components.push(`${screen.width}x${screen.height}`);
        }

        // Timezone offset
        components.push(String(new Date().getTimezoneOffset()));

        // Create hash from combined string
        const combined = components.join('|');
        return simpleHash(combined);
    }

    /**
     * Collect basic device info (non-PII, privacy-friendly)
     * Only includes: platform, browser name, screen resolution
     */
    function getDeviceInfo() {
        const info = {};

        if (typeof navigator !== 'undefined') {
            info.platform = navigator.platform || null;
            info.vendor = navigator.vendor || null;
            
            // Extract browser name (simplified)
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

    /**
     * Simple string hash function (djb2 algorithm)
     * Returns hex string representation
     */
    function simpleHash(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        // Convert to unsigned and then to hex
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * Main API: Get complete fingerprint payload
     * Returns object ready to send to server
     */
    function getFingerprint() {
        return {
            device_id: getOrCreateDeviceId(),
            browser_hash: generateBrowserHash(),
            device_info: getDeviceInfo()
        };
    }

    /**
     * Reset device ID (for testing or logout scenarios)
     */
    function resetDeviceId() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {
            // Ignore
        }
    }

    // Expose public API
    global.DeviceFingerprint = {
        getFingerprint: getFingerprint,
        getDeviceId: getOrCreateDeviceId,
        getBrowserHash: generateBrowserHash,
        resetDeviceId: resetDeviceId
    };

})(typeof window !== 'undefined' ? window : this);
