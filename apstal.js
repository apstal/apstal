// Apstal Analytics Tracker (Open Source)
// https://github.com/ApstalAI/apstal
// Copyright (c) 2024-2026 Apstal. MIT License.
import * as rrweb from "rrweb";
import { gzipSync, strToU8 } from "fflate";
(function() {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var PROJECT_ID = script.getAttribute("data-project");
  if (!PROJECT_ID) {
    return;
  }
  var scriptSrc = script.src;
  var API_URL = scriptSrc.substring(0, scriptSrc.lastIndexOf("/")) + "/api/v1/m";
  var customEndpoint = script.getAttribute("data-endpoint");
  if (customEndpoint) API_URL = customEndpoint;
  var BATCH_INTERVAL = 5e3;
  var MAX_BATCH_SIZE = 25;
  var MAX_PAYLOAD_CHARS = 3e4;
  var DEFAULT_MAX_PAYLOAD = 3e4;
  var MAX_RETRIES = 5;
  var RETRY_TRACKER = {};
  var EVENT_TIMERS = {};
  var SCROLL_THROTTLE = 1e3;
  var MUTATION_DEBOUNCE = 1e3;
  var MAX_VISIBILITY_EVENTS = 20;
  var FEATURES = { session_replays: false, rage_clicks: true, galactic_tracking: false };
  var CONFIG_CACHE_KEY = "_apstal_cfg_" + PROJECT_ID;
  var CONFIG_CACHE_TTL = 3e5;
  fetchFeatureConfig();
  function applyFeatures(features) {
    FEATURES = features;
  }
  function fetchFeatureConfig() {
    try {
      var cached = localStorage.getItem(CONFIG_CACHE_KEY);
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed.ts && Date.now() - parsed.ts < CONFIG_CACHE_TTL) {
          applyFeatures(parsed.features);
          return;
        }
      }
    } catch (e) {
    }
    var baseApiUrl = API_URL.replace(/\/v1\/m$/, "").replace(/\/event$/, "");
    var CONFIG_URL = baseApiUrl + "/v1/config?project_id=" + encodeURIComponent(PROJECT_ID);
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", CONFIG_URL, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4 && xhr.status === 200) {
          try {
            var res = JSON.parse(xhr.responseText);
            if (res.features) {
              applyFeatures(res.features);
              try {
                localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({
                  features: res.features,
                  ts: Date.now()
                }));
              } catch (e) {
              }
            }
          } catch (e) {
          }
        }
      };
      xhr.send();
    } catch (e) {
    }
  }
  var BOT_LIST = "ahrefsbot;ahrefssiteaudit;amazonbot;amazonproductbot;applebot;archive.org_bot;awariobot;baiduspider;bingbot;bingpreview;chrome-lighthouse;facebookexternal;petalbot;pinterest;screaming frog;yahoo! slurp;yandex;adsbot-google;apis-google;duplexweb-google;feedfetcher-google;google favicon;google web preview;google-read-aloud;googlebot;googleweblight;mediapartners-google;storebot-google;gptbot;oai-searchbot;chatgpt-user;perplexitybot;headlesschrome;cypress;slackbot;linkedinbot".split(";");
  function isBot() {
    if (!navigator.userAgent) return false;
    var ua = navigator.userAgent.toLowerCase();
    for (var i = 0; i < BOT_LIST.length; i++) {
      if (ua.indexOf(BOT_LIST[i]) !== -1) return true;
    }
    if (window._phantom || window.__nightmare || window.navigator.webdriver || window.Cypress || window.__plausible) return true;
    return false;
  }
  if (isBot()) {
    return;
  }
  var clickHistory = [];
  var mouseHistory = { lastX: 0, lastY: 0, lastTime: 0, moves: 0, shifts: 0 };
  var userInactivityTimer = null;
  var INACTIVITY_THRESHOLD = 6e4;
  function sntnl_matches(el, selector) {
    if (!el || el.nodeType !== 1 || !selector) return false;
    try {
      if (el.matches) return el.matches(selector);
      if (el.webkitMatchesSelector) return el.webkitMatchesSelector(selector);
      if (el.msMatchesSelector) return el.msMatchesSelector(selector);
    } catch (e) {
    }
    var chunks = selector.split(/(?=\[)|(?=\.)|(?=#)/);
    for (var i = 0; i < chunks.length; i++) {
      var s = chunks[i];
      if (s.indexOf("#") === 0) {
        if (el.id !== s.slice(1)) return false;
      } else if (s.indexOf(".") === 0) {
        if (!el.classList.contains(s.slice(1))) return false;
      } else if (s.indexOf("[") === 0) {
        var match = s.match(/^\[([a-zA-Z0-9\-_]+)\s*([~|^$*]?=)?\s*['"]?([^'"]*)['"]?\]$/);
        if (match) {
          var attr = match[1];
          var op = match[2];
          var val = match[3];
          var curr = el.getAttribute(attr);
          if (curr === null) return false;
          if (!op) continue;
          if (op === "=") {
            if (curr !== val) return false;
          } else if (op === "^=") {
            if (curr.indexOf(val) !== 0) return false;
          } else if (op === "$=") {
            if (curr.indexOf(val, curr.length - val.length) === -1) return false;
          } else if (op === "*=") {
            if (curr.indexOf(val) === -1) return false;
          } else if (op === "~=") {
            if ((" " + curr + " ").indexOf(" " + val + " ") === -1) return false;
          } else if (op === "|=") {
            if (curr !== val && curr.indexOf(val + "-") !== 0) return false;
          }
        }
      } else {
        if (el.tagName.toLowerCase() !== s.toLowerCase()) return false;
      }
    }
    return true;
  }
  var FORBIDDEN_IDS = [
    "undefined",
    "null",
    "nan",
    "na",
    "guest",
    "unknown",
    "anonymous",
    "not_authenticated",
    "[object object]",
    "false",
    "true",
    "{{email}}",
    "{{user_id}}",
    "{{customer.email}}",
    "unique_identifier",
    "0",
    "NaN",
    "Na",
    "hashed_user_id",
    '""',
    "none"
  ];
  function validateIdentity(id) {
    if (!id || typeof id !== "string") return null;
    var clean = id.trim();
    var lowered = clean.toLowerCase();
    if (lowered.length < 2 || lowered.length > 200) return null;
    if (FORBIDDEN_IDS.indexOf(lowered) !== -1) return null;
    if (/^[0\?\s\-]+$/.test(lowered)) return null;
    if (/^(email|none|null|undefined|guest|unknown|na)$/i.test(lowered)) return null;
    return clean;
  }
  var SAMPLING_RATE = parseFloat(localStorage.getItem("_sn_sr") || "1.0");
  var isSampledIn = (function() {
    var decision = localStorage.getItem("_sn_sd");
    if (decision === null) {
      decision = Math.random() <= SAMPLING_RATE ? "1" : "0";
      localStorage.setItem("_sn_sd", decision);
    }
    return decision === "1";
  })();
  if (!isSampledIn) {
    return;
  }
  var PAUSE_KEY = "_sn_paused";
  var PAUSE_TTL = 36e5;
  var trackingPaused = false;
  try {
    var pausedAt = parseInt(localStorage.getItem(PAUSE_KEY) || "0", 10);
    if (pausedAt && Date.now() - pausedAt < PAUSE_TTL) {
      return;
    } else if (pausedAt) {
      localStorage.removeItem(PAUSE_KEY);
    }
  } catch (e) {
  }
  function generateId() {
    return "xxxx-xxxx-xxxx".replace(/x/g, function() {
      return (Math.random() * 16 | 0).toString(16);
    });
  }
  function getOrSet(key, generator) {
    try {
      var val = sessionStorage.getItem(key) || localStorage.getItem(key);
      if (val) return val;
      val = generator();
      if (key === "_apstal_sid") sessionStorage.setItem(key, val);
      else localStorage.setItem(key, val);
      return val;
    } catch (e) {
      return generator();
    }
  }
  function hashString(str) {
    var hash = 0, i, chr;
    if (str.length === 0) return hash;
    for (i = 0; i < str.length; i++) {
      chr = str.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }
  var DEVICE_HASH = getOrSet("_sn_dh", function() {
    return hashString(navigator.userAgent + screen.width + "x" + screen.height);
  });
  var TAB_ID = "t-" + Math.random().toString(36).substr(2, 9);
  var SESSION_ID = (function() {
    try {
      var val = sessionStorage.getItem("_sn_sid");
      if (val) return val;
      val = generateId();
      sessionStorage.setItem("_sn_sid", val);
      return val;
    } catch (e) {
      return generateId();
    }
  })();
  var VISITOR_ID = getOrSet("_sn_vid", generateId);
  var pageEnteredAt = Date.now();
  var detectedTags = [];
  var batteryLevel = null;
  var hasAdblock = false;
  var gpuClassData = null;
  var networkData = null;
  var deviceMemoryData = null;
  function runEnvDetection() {
    var check = function() {
      try {
        if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
          navigator.userAgentData.getHighEntropyValues(["model", "platformVersion", "architecture", "bitness"]).then(function(hints) {
            if (hints.model) detectedTags.push("Model: " + hints.model);
            if (hints.platformVersion) detectedTags.push("OSv: " + hints.platformVersion);
            if (hints.architecture) detectedTags.push("Arch: " + hints.architecture);
            if (hints.bitness) detectedTags.push("Bits: " + hints.bitness);
          }).catch(function() {
          });
        }
        try {
          var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (tz) detectedTags.push("TZ: " + tz.split("/")[0]);
        } catch (e) {
        }
        try {
          if (navigator.plugins && navigator.plugins.length === 0 && !/Mobile|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            detectedTags.push("No Plugins");
          }
        } catch (e) {
        }
        try {
          if (FEATURES.galactic_tracking) {
            fetch("https://www.google-analytics.com/analytics.js", { method: "HEAD", mode: "no-cors" }).catch(function() {
              hasAdblock = true;
              detectedTags.push("AdBlocker Active");
            });
          }
        } catch (e) {
        }
        try {
          var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
          if (conn) {
            networkData = {
              downlink: conn.downlink || null,
              effectiveType: conn.effectiveType || null,
              rtt: conn.rtt || null,
              connectionType: conn.type || null
            };
            if (conn.effectiveType) detectedTags.push("Net: " + conn.effectiveType);
            if (conn.type) detectedTags.push("Conn: " + conn.type);
          }
        } catch (e) {
        }
        try {
          if (navigator.deviceMemory) {
            var ram = navigator.deviceMemory;
            var memTier = "unknown";
            if (ram >= 8) memTier = "high";
            else if (ram >= 4) memTier = "mid";
            else if (ram >= 2) memTier = "low";
            else memTier = "budget";
            deviceMemoryData = {
              ram,
              tier: memTier
            };
            detectedTags.push("RAM: " + ram + "GB");
          }
        } catch (e) {
        }
      } catch (e) {
      }
    };
    if (window.requestIdleCallback) {
      window.requestIdleCallback(check);
    } else {
      setTimeout(check, 1e3);
    }
    var gpuCheck = function() {
      try {
        var canvas = document.createElement("canvas");
        var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
          var maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
          var maxVp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
          var maxFragUni = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
          var exts = gl.getSupportedExtensions();
          var extCount = exts ? exts.length : 0;
          var gpuTier = "unknown";
          if (maxTex >= 32768 && extCount >= 50) gpuTier = "workstation";
          else if (maxTex >= 16384 && extCount >= 40) gpuTier = "high";
          else if (maxTex >= 8192 && extCount >= 25) gpuTier = "mid";
          else gpuTier = "low";
          gpuClassData = {
            maxTexture: maxTex,
            maxRenderbuffer: maxRb,
            maxViewport: maxVp ? [maxVp[0], maxVp[1]] : null,
            maxFragUniforms: maxFragUni,
            extensions: extCount,
            tier: gpuTier
          };
          detectedTags.push("GPU: " + gpuTier);
          var ext = gl.getExtension("WEBGL_lose_context");
          if (ext) ext.loseContext();
        }
      } catch (e) {
      }
    };
    if (window.requestIdleCallback) {
      setTimeout(function() {
        window.requestIdleCallback(gpuCheck);
      }, 2e3);
    } else {
      setTimeout(gpuCheck, 3e3);
    }
  }
  if (document.readyState === "complete") {
    runEnvDetection();
  } else {
    window.addEventListener("load", runEnvDetection);
  }
  var honeypotTriggered = false;
  function setupHoneypot() {
    try {
      var trap = document.createElement("a");
      trap.href = "/" + Math.random().toString(36).slice(2, 8);
      trap.style.cssText = "opacity:0;position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:auto;z-index:-1";
      trap.setAttribute("tabindex", "-1");
      trap.setAttribute("aria-hidden", "true");
      trap.textContent = " ";
      document.body.appendChild(trap);
      trap.addEventListener("click", function(e) {
        e.preventDefault();
        honeypotTriggered = true;
      });
    } catch (e) {
    }
  }
  if (document.readyState === "complete") {
    setupHoneypot();
  } else {
    window.addEventListener("load", setupHoneypot);
  }
  var mousePoints = [];
  var mouseEntropyScore = -1;
  document.addEventListener("mousemove", function(e) {
    if (mousePoints.length < 30) {
      mousePoints.push([e.clientX, e.clientY]);
    }
    if (mousePoints.length === 30 && mouseEntropyScore === -1) {
      mouseEntropyScore = calcMouseEntropy();
    }
  }, { passive: true });
  function calcMouseEntropy() {
    if (mousePoints.length < 10) return -1;
    var angles = [];
    for (var i = 1; i < mousePoints.length - 1; i++) {
      var dx1 = mousePoints[i][0] - mousePoints[i - 1][0];
      var dy1 = mousePoints[i][1] - mousePoints[i - 1][1];
      var dx2 = mousePoints[i + 1][0] - mousePoints[i][0];
      var dy2 = mousePoints[i + 1][1] - mousePoints[i][1];
      if (dx1 === 0 && dy1 === 0) continue;
      if (dx2 === 0 && dy2 === 0) continue;
      var angle = Math.atan2(dy2, dx2) - Math.atan2(dy1, dx1);
      angles.push(angle);
    }
    if (angles.length < 3) return 0;
    var mean = 0;
    for (var j = 0; j < angles.length; j++) mean += angles[j];
    mean /= angles.length;
    var variance = 0;
    for (var j = 0; j < angles.length; j++) variance += (angles[j] - mean) * (angles[j] - mean);
    variance /= angles.length;
    return Math.min(100, Math.round(variance * 100));
  }
  function detectBrowser() {
    var ua = navigator.userAgent;
    var vendor = navigator.vendor || "";
    var name = "Unknown";
    var version = null;
    if (navigator.brave && typeof navigator.brave.isBrave === "function") name = "Brave";
    else if (ua.indexOf("OPR/") !== -1 || ua.indexOf("Opera") !== -1) name = "Opera";
    else if (ua.indexOf("SamsungBrowser") !== -1) name = "Samsung Browser";
    else if (ua.indexOf("UCBrowser") !== -1) name = "UC Browser";
    else if (ua.indexOf("YaBrowser") !== -1) name = "Yandex";
    else if (ua.indexOf("Firefox/") !== -1) name = "Firefox";
    else if (ua.indexOf("Edg/") !== -1) name = "Edge";
    else if (ua.indexOf("Chrome/") !== -1) name = "Chrome";
    else if (ua.indexOf("Safari/") !== -1) name = "Safari";
    var match = ua.match(/(applewebkit|rv|chrome|firefox|version|opr|edge|edg)\/([0-9\.]+)/i);
    if (match && match[2]) version = match[2];
    return { name, version };
  }
  function detectOS() {
    var ua = navigator.userAgent;
    if (/Windows/i.test(ua)) {
      if (/Phone/.test(ua) || /WPDesktop/.test(ua)) return "Windows Phone";
      return "Windows";
    }
    if (/(iPhone|iPad|iPod)/.test(ua)) return "iOS";
    if (/Android/.test(ua)) return "Android";
    if (/(BlackBerry|PlayBook|BB10)/i.test(ua)) return "BlackBerry";
    if (/Mac/i.test(ua)) return "Mac OS X";
    if (/Linux/.test(ua)) return "Linux";
    if (/CrOS/.test(ua)) return "Chrome OS";
    return "Unknown";
  }
  var BROWSER_INFO = detectBrowser();
  var DETECTED_OS = detectOS();
  var LOCK_KEY = "_sn_lck";
  var LOCK_TTL = 3e3;
  function isMasterTab() {
    try {
      var now = Date.now();
      var raw = localStorage.getItem(LOCK_KEY);
      if (!raw) return true;
      var lock = JSON.parse(raw);
      return now - lock.t > LOCK_TTL || lock.id === TAB_ID;
    } catch (e) {
      return true;
    }
  }
  function refreshTabLock() {
    try {
      if (isMasterTab()) {
        localStorage.setItem(LOCK_KEY, JSON.stringify({ t: Date.now(), id: TAB_ID }));
      }
    } catch (e) {
    }
  }
  setInterval(refreshTabLock, 2e3);
  var BLOCKLISTED_ATTRS = ["password", "ssn", "cvv", "card", "key", "secret", "token", "auth", "onclick", "onmouseover", "onkeydown", "style", "data-reactid", "data-v-"];
  function isRedacted(el) {
    try {
      var curr = el;
      while (curr && curr !== document.body) {
        if (curr.hasAttribute("data-sntnl-redact") || curr.hasAttribute("data-heap-redact-text")) return true;
        curr = curr.parentElement;
      }
    } catch (e) {
    }
    return false;
  }
  function scrubPII(text) {
    if (!text || typeof text !== "string") return text;
    var emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    var tokenRegex = /\b[a-zA-Z0-9-_]{32,}\b/g;
    var cardRegex = /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|(?:2131|1800|35[0-9]{3})[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g;
    var ssnRegex = /\b\d{3}-?\d{2}-?\d{4}\b/g;
    return text.replace(emailRegex, "[EMAIL_REDACTED]").replace(cardRegex, "[CARD_REDACTED]").replace(ssnRegex, "[SSN_REDACTED]").replace(tokenRegex, "[TOKEN_REDACTED]");
  }
  function scrubURL(url) {
    if (!url || typeof url !== "string") return url;
    try {
      var sensitiveKeys = ["token", "auth", "key", "secret", "hash", "id_token", "access_token", "refresh_token", "pwd", "password"];
      var u = new URL(url);
      var params = new URLSearchParams(u.search);
      var hash = u.hash;
      var changed = false;
      params.forEach(function(val, key) {
        var k = key.toLowerCase();
        if (sensitiveKeys.some(function(sk) {
          return k.indexOf(sk) !== -1;
        })) {
          params.set(key, "[REDACTED]");
          changed = true;
        }
      });
      if (hash) {
        sensitiveKeys.forEach(function(sk) {
          if (hash.toLowerCase().indexOf(sk) !== -1) {
            hash = "#[REDACTED]";
            changed = true;
          }
        });
      }
      if (!changed) return url;
      u.search = params.toString();
      u.hash = hash;
      return u.toString();
    } catch (e) {
      return url;
    }
  }
  function getSafeClassName(el) {
    try {
      var className = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
      return className.trim().slice(0, 300);
    } catch (e) {
      return "";
    }
  }
  function getHierarchy(el) {
    try {
      var path = [];
      var current = el;
      var depth = 0;
      while (current && current.tagName && depth < 6) {
        var tag = current.tagName.toLowerCase();
        var id = current.id ? "#" + current.id : "";
        if (id && (BLOCKLISTED_ATTRS.some(function(a) {
          return id.indexOf(a) !== -1;
        }) || id.length > 60)) {
          id = "#[REDACTED]";
        }
        var cls = getSafeClassName(current);
        var displayCls = cls ? "." + cls.split(/\s+/)[0] : "";
        path.unshift(tag + id + displayCls);
        current = current.parentElement;
        depth++;
      }
      return path.join(" > ");
    } catch (e) {
      return null;
    }
  }
  function extractSearchQuery(ref) {
    if (!ref) return null;
    try {
      var url = new URL(ref);
      var params = new URLSearchParams(url.search);
      return params.get("q") || params.get("p") || null;
    } catch (e) {
      return null;
    }
  }
  function detectTranslation() {
    try {
      var html = document.documentElement;
      var isTranslated = html.classList.contains("translated-ltr") || html.classList.contains("translated-rtl") || !!document.querySelector(".skiptranslate") || !!document.querySelector("iframe.goog-te-menu-frame");
      return isTranslated;
    } catch (e) {
      return false;
    }
  }
  function captureAttribution() {
    try {
      var urlParams = new URLSearchParams(window.location.search);
      var AD_IDS = "dclid fbclid gclid ko_click_id li_fat_id msclkid sccid ttclid twclid wbraid".split(" ");
      var utm = {
        source: urlParams.get("utm_source"),
        medium: urlParams.get("utm_medium"),
        campaign: urlParams.get("utm_campaign"),
        content: urlParams.get("utm_content"),
        term: urlParams.get("utm_term")
      };
      var clickId = null;
      for (var i = 0; i < AD_IDS.length; i++) {
        var val = urlParams.get(AD_IDS[i]);
        if (val) {
          utm[AD_IDS[i]] = val;
          if (!clickId) clickId = val;
        }
      }
      utm.click_id = clickId;
      if (!utm.source && document.referrer) {
        var ref = document.referrer.toLowerCase();
        var engine = null;
        if (ref.indexOf("google.") !== -1) engine = "google";
        else if (ref.indexOf("bing.com") !== -1) engine = "bing";
        else if (ref.indexOf("yahoo.com") !== -1) engine = "yahoo";
        else if (ref.indexOf("duckduckgo.com") !== -1) engine = "duckduckgo";
        if (engine) {
          utm.source = engine;
          utm.medium = "organic";
        }
      }
      var stored = JSON.parse(localStorage.getItem("_sn_attr") || "{}");
      var firstTouch = JSON.parse(localStorage.getItem("_sn_ft") || "{}");
      if (!firstTouch.landing_page) {
        var ft = {};
        for (var k in utm) {
          if (utm[k]) ft["initial_" + k] = utm[k];
        }
        if (!ft.initial_source && document.referrer) {
          ft.initial_source = extractHostname(document.referrer);
          ft.initial_medium = "referral";
        }
        if (!firstTouch.landing_page) {
          ft.landing_page = scrubURL(location.href);
          ft.initial_referrer = scrubURL(document.referrer);
          localStorage.setItem("_sn_ft", JSON.stringify(ft));
        }
      }
      var hasNewAttr = false;
      for (var k in utm) {
        if (utm[k]) {
          stored[k] = utm[k];
          hasNewAttr = true;
        }
      }
      if (hasNewAttr) localStorage.setItem("_sn_attr", JSON.stringify(stored));
      return {
        current: stored,
        first: JSON.parse(localStorage.getItem("_sn_ft") || "{}")
      };
    } catch (e) {
      return { current: {}, first: {} };
    }
  }
  function extractHostname(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return null;
    }
  }
  function getPreviousUrl() {
    try {
      return sessionStorage.getItem("_sn_prev") || null;
    } catch (e) {
      return null;
    }
  }
  function updatePreviousUrl() {
    try {
      sessionStorage.setItem("_sn_prev", scrubURL(location.href));
    } catch (e) {
    }
  }
  var ATTR = captureAttribution();
  var CURRENT_SEARCH_QUERY = extractSearchQuery(document.referrer);
  if (detectTranslation()) detectedTags.push("Translated Page");
  var BUFFER_KEY = "_sn_q";
  var queue = [];
  function syncStorage() {
    try {
      var data = JSON.stringify(queue);
      if (data.length > 5e4) return;
      localStorage.setItem(BUFFER_KEY, data);
    } catch (e) {
    }
  }
  function loadStorage() {
    try {
      var stored = localStorage.getItem(BUFFER_KEY);
      if (stored) {
        var items = JSON.parse(stored);
        if (Array.isArray(items)) {
          queue = items.concat(queue);
        }
      }
    } catch (e) {
    }
  }
  function isOptedOut() {
    try {
      return localStorage.getItem("_sn_oo") === "1";
    } catch (e) {
      return false;
    }
  }
  function enqueue(type, data) {
    if (isOptedOut() || trackingPaused) return;
    var attr = ATTR;
    var evt = {
      type,
      url: scrubURL(location.href),
      path: location.pathname,
      title: document.title,
      referrer: scrubURL(document.referrer),
      prev_url: getPreviousUrl(),
      sessionId: SESSION_ID,
      visitorId: VISITOR_ID,
      deviceHash: DEVICE_HASH,
      viewport: window.innerWidth + "x" + window.innerHeight,
      timeOnPage: Math.round((Date.now() - pageEnteredAt) / 1e3),
      tags: detectedTags.join(","),
      adblock: hasAdblock,
      isBot: !!navigator.webdriver || honeypotTriggered || isBot() || screen.width === 400 && screen.height === 400 || mouseEntropyScore === 0,
      mouseEntropy: mouseEntropyScore,
      battery: batteryLevel,
      detectedBrowser: BROWSER_INFO.name,
      browserVersion: BROWSER_INFO.version,
      detectedOS: DETECTED_OS,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      customUserId: localStorage.getItem("_sn_id") || null,
      searchQuery: CURRENT_SEARCH_QUERY,
      // Device Intelligence
      gpuClass: gpuClassData,
      networkInfo: networkData,
      deviceMemory: deviceMemoryData,
      screenResolution: screen.width + "x" + screen.height,
      pixelRatio: window.devicePixelRatio || 1,
      // Marketing Attribution
      utm_source: attr.current.source || null,
      utm_medium: attr.current.medium || null,
      utm_campaign: attr.current.campaign || null,
      utm_content: attr.current.content || null,
      utm_term: attr.current.term || null,
      click_id: attr.current.click_id || null
    };
    if (attr.first) {
      for (var key in attr.first) {
        if (attr.first.hasOwnProperty(key)) {
          evt[key] = attr.first[key];
        }
      }
    }
    updatePreviousUrl();
    if (data) {
      for (var k in data) {
        if (data.hasOwnProperty(k)) {
          var val = data[k];
          if (typeof val === "string" && (k === "text" || k === "hierarchy" || k === "elClass")) {
            val = scrubPII(val);
          }
          evt[k] = val;
        }
      }
    }
    if (EVENT_TIMERS[type]) {
      var duration = (Date.now() - EVENT_TIMERS[type]) / 1e3;
      evt.$duration = Math.round(duration * 1e3) / 1e3;
      delete EVENT_TIMERS[type];
    }
    evt._id = Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    evt._retries = 0;
    queue.push(evt);
    syncStorage();
    if (queue.length >= MAX_BATCH_SIZE) {
      flush();
    }
  }
  function extractPrice(str) {
    if (!str) return null;
    var matches = str.match(/([0-9]{1,3}(?:[,. ][0-9]{3})*(?:[. ,][0-9]{2})?)/);
    if (!matches) return null;
    return parseFloat(matches[0].replace(/[ ,]/g, "").replace(",", "."));
  }
  function checkRevenueSignals(el) {
    try {
      var text = (el.innerText || el.value || "").toLowerCase();
      var price = extractPrice(text);
      if (price && (text.indexOf("buy") !== -1 || text.indexOf("purchase") !== -1 || text.indexOf("add to cart") !== -1 || text.indexOf("pay") !== -1)) {
        return { amount: price, currency: "USD" };
      }
    } catch (e) {
    }
    return null;
  }
  function flush() {
    if (queue.length === 0) return;
    if (!isMasterTab()) return;
    refreshTabLock();
    while (queue.length > 0) {
      var batch = [];
      var currentSize = 0;
      while (queue.length > 0) {
        var nextEvt = queue[0];
        var evtSize = JSON.stringify(nextEvt).length;
        if (batch.length > 0 && currentSize + evtSize > MAX_PAYLOAD_CHARS) {
          break;
        }
        batch.push(queue.shift());
        currentSize += evtSize;
      }
      var payload = JSON.stringify({
        projectId: PROJECT_ID,
        events: batch
      });
      if (window.fetch) {
        window.fetch(API_URL, {
          method: "POST",
          body: payload,
          headers: { "Content-Type": "text/plain" },
          keepalive: true
        }).then(function(res) {
          if (res.status === 413) {
            MAX_PAYLOAD_CHARS = Math.max(2e3, Math.floor(MAX_PAYLOAD_CHARS / 2));
          } else if (res.ok) {
            res.json().then(function(body) {
              if (body && body.paused) {
                trackingPaused = true;
                queue = [];
                try {
                  localStorage.setItem(PAUSE_KEY, String(Date.now()));
                } catch (e) {
                }
                try {
                  localStorage.removeItem(BUFFER_KEY);
                } catch (e) {
                }
                return;
              }
              if (MAX_PAYLOAD_CHARS < DEFAULT_MAX_PAYLOAD) {
                MAX_PAYLOAD_CHARS = Math.min(DEFAULT_MAX_PAYLOAD, MAX_PAYLOAD_CHARS + 2e3);
              }
              batch.forEach(function(item) {
                if (item._id) delete RETRY_TRACKER[item._id];
              });
            }).catch(function() {
              if (MAX_PAYLOAD_CHARS < DEFAULT_MAX_PAYLOAD) {
                MAX_PAYLOAD_CHARS = Math.min(DEFAULT_MAX_PAYLOAD, MAX_PAYLOAD_CHARS + 2e3);
              }
              batch.forEach(function(item) {
                if (item._id) delete RETRY_TRACKER[item._id];
              });
            });
          } else {
            handleRetry(batch);
          }
        }).catch(function() {
          handleRetry(batch);
        });
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(API_URL, payload);
      }
      syncStorage();
    }
  }
  function handleRetry(batch) {
    var toRetry = [];
    batch.forEach(function(item) {
      item._retries = (item._retries || 0) + 1;
      if (item._retries < MAX_RETRIES) {
        toRetry.push(item);
      }
    });
    if (toRetry.length > 0) {
      queue = toRetry.concat(queue);
      syncStorage();
    }
  }
  function startPulse() {
    setInterval(function() {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        updateScrollDepth();
        var pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        var scrollPerc = pageHeight ? Math.round(maxScrollDepth / pageHeight * 100) : 0;
        enqueue("engagement_pulse", {
          $scroll_percentage: Math.min(100, scrollPerc),
          $duration_cumulative: Math.round((Date.now() - pageEnteredAt) / 1e3)
        });
      }
    }, 1e4);
  }
  startPulse();
  setInterval(flush, BATCH_INTERVAL);
  var vitals = { fcp: null, lcp: null, cls: 0, ttfb: null };
  var maxScrollDepth = 0;
  function updateScrollDepth() {
    var current = window.scrollY || window.pageYOffset || 0;
    var depth = current + window.innerHeight;
    if (depth > maxScrollDepth) maxScrollDepth = depth;
  }
  window.addEventListener("scroll", updateScrollDepth, { passive: true });
  function sendPageLeave() {
    var pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    var foldContent = window.innerHeight;
    var foldLinePerc = pageHeight ? Math.round(foldContent / pageHeight * 100) : 0;
    var scrollPerc = pageHeight ? Math.round(maxScrollDepth / pageHeight * 100) : 0;
    var wordsOnPage = (document.body.innerText || "").split(/\s+/).length || 0;
    var wordsSeen = Math.ceil(wordsOnPage * (Math.min(100, scrollPerc) / 100));
    var activeTimeSpent = Math.max(1, Math.round((Date.now() - pageEnteredAt) / 1e3) - (typeof totalAwaySeconds !== "undefined" ? totalAwaySeconds : 0));
    var readingSpeed = Math.round(wordsSeen / (activeTimeSpent / 60));
    enqueue("$mp_page_leave", {
      $max_scroll_view_depth: Math.round(maxScrollDepth),
      $scroll_height: pageHeight,
      $scroll_percentage: Math.min(100, scrollPerc),
      $fold_line_percentage: Math.min(100, foldLinePerc),
      reading_speed_wpm: readingSpeed,
      active_seconds: activeTimeSpent
    });
    flush();
  }
  var leaveSent = false;
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "hidden") {
      if (!leaveSent) {
        sendPageLeave();
        leaveSent = true;
      }
      flush();
    }
  });
  window.addEventListener("pagehide", function() {
    if (!leaveSent) {
      sendPageLeave();
      leaveSent = true;
    }
    flush();
  });
  try {
    if (performance && performance.getEntriesByType) {
      var nav = performance.getEntriesByType("navigation")[0];
      if (nav) vitals.ttfb = Math.round(nav.responseStart - nav.startTime);
    }
  } catch (e) {
  }
  if (window.PerformanceObserver) {
    try {
      var po = new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (entry.name === "first-contentful-paint") vitals.fcp = Math.round(entry.startTime);
          if (entry.entryType === "largest-contentful-paint") vitals.lcp = Math.round(entry.startTime);
          if (entry.entryType === "layout-shift" && !entry.hadRecentInput) vitals.cls += entry.value;
        }
      });
      po.observe({ type: "paint", buffered: true });
      po.observe({ type: "largest-contentful-paint", buffered: true });
      po.observe({ type: "layout-shift", buffered: true });
    } catch (e) {
    }
  }
  function trackPageview() {
    try {
      var perfData = Object.assign({}, vitals);
      try {
        perfData.domNodes = document.querySelectorAll("*").length;
        perfData.scripts = document.querySelectorAll("script[src]").length;
      } catch (e) {
      }
      try {
        if (performance && performance.timing) {
          var t = performance.timing;
          perfData.loadTime = t.loadEventEnd - t.navigationStart;
          if (perfData.loadTime < 0) perfData.loadTime = null;
        } else if (performance && performance.getEntriesByType) {
          var nav2 = performance.getEntriesByType("navigation");
          if (nav2 && nav2[0]) {
            perfData.loadTime = Math.round(nav2[0].loadEventEnd);
          }
        }
      } catch (e) {
      }
      enqueue("pageview", perfData);
      setTimeout(captureDOMMap, 1500);
    } catch (e) {
    }
  }
  loadStorage();
  if (queue.length > 0) flush();
  captureAttribution();
  if (document.readyState === "complete") {
    trackPageview();
  } else {
    window.addEventListener("load", function() {
      trackPageview();
    });
  }
  var lastClickTime = 0;
  var lastClickTarget = null;
  var lastClickPos = null;
  var rapidClickCount = 0;
  function getLogicalTarget(e) {
    var target = e.target;
    var path = e.composedPath ? e.composedPath() : [];
    var selectors = ["a", "button", 'input[type="submit"]', 'input[type="button"]', '[role="button"]', "[data-sntnl]"];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (!el || el.nodeType !== 1) continue;
      if (el.classList.contains("mp-no-track")) return null;
      for (var j = 0; j < selectors.length; j++) {
        if (sntnl_matches(el, selectors[j])) return el;
      }
      if (el === target) break;
    }
    return target;
  }
  document.addEventListener("click", function(e) {
    var target = getLogicalTarget(e);
    var el = target;
    var rect = el.getBoundingClientRect();
    var x_rel = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    var y_rel = rect.height ? (e.clientY - rect.top) / rect.height : 0;
    var text = (el.innerText || el.value || el.alt || el.ariaLabel || "").slice(0, 200).trim();
    if (isRedacted(el)) {
      text = "[REDACTED_BY_USER]";
    }
    var data = {
      tag: el.tagName ? el.tagName.toLowerCase() : null,
      text,
      elId: el.id || null,
      elClass: getSafeClassName(el),
      hierarchy: getHierarchy(el),
      href: el.href || el.closest("a")?.href || null,
      position: { x: e.pageX, y: e.pageY },
      xRel: Math.round(x_rel * 1e3) / 1e3,
      yRel: Math.round(y_rel * 1e3) / 1e3
    };
    var now = Date.now();
    var JITTER_THRESHOLD = 30;
    var isNear = lastClickPos && Math.abs(e.pageX - lastClickPos.x) < JITTER_THRESHOLD && Math.abs(e.pageY - lastClickPos.y) < JITTER_THRESHOLD;
    if (now - lastClickTime < 800 && el === lastClickTarget && isNear) {
      rapidClickCount++;
      if (rapidClickCount >= 3) {
        enqueue("rage_click", data);
        rapidClickCount = 0;
      }
    } else {
      rapidClickCount = 1;
    }
    lastClickTime = now;
    lastClickTarget = el;
    lastClickPos = { x: e.pageX, y: e.pageY };
    if (el.tagName === "A" && el.href) {
      try {
        var host = new URL(el.href).hostname;
        if (host && host !== location.hostname) {
          enqueue("exit_link", {
            href: el.href,
            target_domain: host
          });
        }
      } catch (e2) {
      }
    }
    enqueue("click", data);
  }, true);
  (function(history2) {
    var pushState = history2.pushState;
    history2.pushState = function(state) {
      var ret = pushState.apply(history2, arguments);
      window.dispatchEvent(new Event("pushstate"));
      window.dispatchEvent(new Event("locationchange"));
      return ret;
    };
    var replaceState = history2.replaceState;
    history2.replaceState = function(state) {
      var ret = replaceState.apply(history2, arguments);
      window.dispatchEvent(new Event("replacestate"));
      window.dispatchEvent(new Event("locationchange"));
      return ret;
    };
    window.addEventListener("popstate", function() {
      window.dispatchEvent(new Event("locationchange"));
    });
  })(window.history);
  window.addEventListener("locationchange", function() {
    pageEnteredAt = Date.now();
    ATTR = captureAttribution();
    trackPageview();
  });
  document.addEventListener("copy", function() {
    try {
      var selection = window.getSelection().toString().trim();
      if (selection.length > 20) {
        if (detectedTags.indexOf("Aggressive Evaluator") === -1) {
          detectedTags.push("Aggressive Evaluator");
        }
        enqueue("scrape_copy", { text: selection.slice(0, 500) });
      }
    } catch (e) {
    }
  });
  var maxScroll = 0;
  var scrollTimer = null;
  var scrollMilestones = { 25: false, 50: false, 75: false, 90: false, 100: false };
  function onScroll() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var docHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      ) - window.innerHeight;
      if (docHeight <= 0) return;
      var percent = Math.min(100, Math.round(scrollTop / docHeight * 100));
      if (percent > maxScroll) {
        maxScroll = percent;
        var milestones = [25, 50, 75, 90, 100];
        for (var i = 0; i < milestones.length; i++) {
          var m = milestones[i];
          if (percent >= m && !scrollMilestones[m]) {
            scrollMilestones[m] = true;
            enqueue("scroll", { scrollDepth: m });
          }
        }
      }
    }, SCROLL_THROTTLE);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  var trackedForms = /* @__PURE__ */ new WeakSet();
  function trackForms() {
    var forms = document.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) {
      if (trackedForms.has(forms[i])) continue;
      trackedForms.add(forms[i]);
      (function(form) {
        var firstField = form.querySelector("input, textarea, select");
        if (firstField) {
          firstField.addEventListener("focus", function() {
            enqueue("form_interact", {
              tag: "form",
              elId: form.id || null,
              text: "form_start",
              elClass: form.className && typeof form.className === "string" ? form.className.slice(0, 200) : null
            });
          }, { once: true });
        }
        form.addEventListener("submit", function() {
          var emailField = form.querySelector('input[type="email"], input[name*="email"], input[id*="email"]');
          var identity = emailField ? emailField.value : null;
          enqueue("form_submit", {
            tag: "form",
            elId: form.id || null,
            text: "form_submit",
            identity,
            elClass: form.className && typeof form.className === "string" ? form.className.slice(0, 200) : null
          });
        });
        form.querySelectorAll("input").forEach(function(input) {
          input.addEventListener("blur", function() {
            if (input.value && (input.type === "email" || input.name.indexOf("email") !== -1)) {
              enqueue("identity_capture", {
                email: input.value,
                fieldName: input.name || input.id
              });
            }
          });
        });
      })(forms[i]);
    }
  }
  if (document.readyState !== "loading") {
    trackForms();
  } else {
    document.addEventListener("DOMContentLoaded", trackForms);
  }
  setInterval(trackForms, 5e3);
  window.addEventListener("error", function(e) {
    enqueue("error", {
      text: (e.message || "Unknown error").slice(0, 500),
      tag: "error",
      elId: e.filename ? e.filename.split("/").pop() : null,
      position: { x: e.lineno || 0, y: e.colno || 0 }
    });
  });
  window.addEventListener("unhandledrejection", function(e) {
    enqueue("error", {
      text: ("Unhandled Promise: " + String(e.reason || "")).slice(0, 500),
      tag: "promise_error"
    });
  });
  var clickHistory = [];
  var mouseHistory = { lastX: 0, lastY: 0, lastTime: 0, moves: 0, shifts: 0 };
  var stagnationTimer = null;
  var STAGNATION_LIMIT = 6e4;
  function checkRageClick(e) {
    var now = Date.now();
    clickHistory.push({ x: e.clientX, y: e.clientY, time: now });
    clickHistory = clickHistory.filter(function(c) {
      return now - c.time < 1e3;
    });
    if (clickHistory.length >= 4) {
      var first = clickHistory[0];
      var isCluster = clickHistory.every(function(c) {
        return Math.abs(c.x - first.x) < 50 && Math.abs(c.y - first.y) < 50;
      });
      if (isCluster) {
        enqueue("rage_click", {
          x: e.clientX,
          y: e.clientY,
          count: clickHistory.length,
          selector: sntnl_get_selector(e.target)
        });
        clickHistory = [];
      }
    }
  }
  function checkConfusion(e) {
    var now = Date.now();
    var dt = now - mouseHistory.lastTime;
    if (dt < 50) return;
    var dx = e.clientX - mouseHistory.lastX;
    var dy = e.clientY - mouseHistory.lastY;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > 10) {
      mouseHistory.moves++;
      if (Math.abs(dx) > 5 && Math.abs(dy) > 5) mouseHistory.shifts++;
      if (mouseHistory.moves > 25 && mouseHistory.shifts > 15) {
        enqueue("user_confusion", { intensity: mouseHistory.shifts / mouseHistory.moves });
        mouseHistory.moves = 0;
        mouseHistory.shifts = 0;
      }
    }
    mouseHistory.lastX = e.clientX;
    mouseHistory.lastY = e.clientY;
    mouseHistory.lastTime = now;
    resetStagnation();
  }
  function resetStagnation() {
    if (stagnationTimer) clearTimeout(stagnationTimer);
    stagnationTimer = setTimeout(function() {
      enqueue("stagnant_session", { duration: STAGNATION_LIMIT });
    }, STAGNATION_LIMIT);
  }
  var exitFired = false;
  document.addEventListener("mouseleave", function(e) {
    if (exitFired) return;
    if (e.clientY < 5) {
      exitFired = true;
      enqueue("exit_intent", { scrollDepth: maxScroll });
    }
  });
  function onLeave() {
    updateScrollDepth();
    enqueue("exit", {
      scrollDepth: Math.round(maxScroll),
      timeOnPage: Math.round((Date.now() - pageEnteredAt) / 1e3)
    });
    flush();
  }
  var tabSwitches = 0;
  var lastHiddenAt = null;
  var totalAwaySeconds = 0;
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "hidden") {
      onLeave();
      lastHiddenAt = Date.now();
      tabSwitches++;
      enqueue("page_leave", { switchCount: tabSwitches });
      flush();
    } else if (lastHiddenAt) {
      var away = Math.round((Date.now() - lastHiddenAt) / 1e3);
      if (away >= 2) {
        totalAwaySeconds += away;
        enqueue("tab_return", {
          awaySeconds: away,
          switchCount: tabSwitches
        });
        flush();
      }
      lastHiddenAt = null;
    }
  });
  window.addEventListener("beforeunload", onLeave);
  var visibilityEventCount = 0;
  var reportedSignatures = /* @__PURE__ */ new Set();
  var mutationTimer = null;
  function setupMutationWatcher() {
    if (!window.MutationObserver) return;
    var observer = new MutationObserver(function(mutations) {
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(function() {
        processMutations(mutations);
      }, MUTATION_DEBOUNCE);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  function processMutations(mutations) {
    if (visibilityEventCount >= MAX_VISIBILITY_EVENTS) return;
    try {
      var interestingSelectors = [
        "button",
        "a",
        "input",
        '[role="dialog"]',
        '[role="alert"]',
        ".modal",
        ".toast",
        ".popup",
        ".error-message",
        ".ai-response",
        "[data-sntnl]"
      ];
      interestingSelectors.forEach(function(selector) {
        var els = document.querySelectorAll(selector);
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            var text = (el.innerText || el.value || "").trim().slice(0, 300);
            if (text.length < 3) continue;
            if (isRedacted(el)) {
              text = "[REDACTED_BY_USER]";
            }
            var hierarchy = getHierarchy(el);
            var signature = el.tagName + ":" + text + ":" + hierarchy;
            if (!reportedSignatures.has(signature)) {
              reportedSignatures.add(signature);
              visibilityEventCount++;
              enqueue("visibility", {
                tag: el.tagName.toLowerCase(),
                text,
                hierarchy,
                elId: el.id || null,
                elClass: getSafeClassName(el)
              });
              if (visibilityEventCount >= MAX_VISIBILITY_EVENTS) break;
            }
          }
        }
      });
    } catch (e) {
    }
  }
  if (document.readyState === "complete") {
    setupMutationWatcher();
  } else {
    window.addEventListener("load", setupMutationWatcher);
  }
  var lastPathname = location.pathname;
  function checkRouteChange() {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      pageEnteredAt = Date.now();
      maxScroll = 0;
      scrollMilestones = { 25: false, 50: false, 75: false, 90: false, 100: false };
      trackPageview();
      trackForms();
    }
  }
  var origPush = history.pushState;
  var origReplace = history.replaceState;
  history.pushState = function() {
    origPush.apply(this, arguments);
    setTimeout(checkRouteChange, 50);
  };
  history.replaceState = function() {
    origReplace.apply(this, arguments);
    setTimeout(checkRouteChange, 50);
  };
  window.addEventListener("popstate", function() {
    setTimeout(checkRouteChange, 50);
  });
  function extractBrandContext() {
    try {
      var bodyStyle = window.getComputedStyle(document.body);
      var metaDescEl = document.querySelector('meta[name="description"]');
      var brandColors = [];
      document.querySelectorAll("button, a.btn, .button").forEach(function(btn) {
        var btnStyle = window.getComputedStyle(btn);
        var btnBg = btnStyle.backgroundColor;
        if (btnBg !== "rgba(0, 0, 0, 0)" && btnBg !== "transparent") {
          if (brandColors.indexOf(btnBg) === -1) brandColors.push(btnBg);
        }
      });
      return {
        title: document.title,
        description: metaDescEl ? metaDescEl.getAttribute("content") : "",
        theme: {
          background: bodyStyle.backgroundColor,
          text: bodyStyle.color,
          fontFamily: bodyStyle.fontFamily,
          accentColors: brandColors.slice(0, 3)
        }
      };
    } catch (e) {
      return null;
    }
  }
  var _replayStarted = false;
  function startSessionReplay() {
    if (!FEATURES.session_replays || _replayStarted) return;
    _replayStarted = true;
    var rrwebEvents = [];
    var baseApiUrl = API_URL.replace(/\/v1\/m$/, "").replace(/\/event$/, "");
    var sendChunk = function(events, immediate) {
      if (events.length === 0) return;
      var doSend = function() {
        try {
          var payloadStr = JSON.stringify(events);
          var compressed = gzipSync(strToU8(payloadStr), { level: 9, mem: 8 });
          var chunkIndex = Date.now();
          var INGEST_URL = baseApiUrl + "/v1/stream?pid=" + encodeURIComponent(PROJECT_ID) + "&sid=" + encodeURIComponent(SESSION_ID) + "&chunk=" + chunkIndex;
          var blob = new Blob([compressed], { type: "application/gzip" });
          if (blob.size < 6e4 && navigator.sendBeacon) {
            navigator.sendBeacon(INGEST_URL, blob);
          } else if (window.fetch) {
            window.fetch(INGEST_URL, {
              method: "POST",
              body: blob,
              keepalive: immediate && blob.size < 6e4
            }).catch(function() {
            });
          }
        } catch (e) {
        }
      };
      if (immediate) {
        doSend();
      } else {
        setTimeout(doSend, 0);
      }
    };
    var flushReplay = function(immediate) {
      if (rrwebEvents.length === 0) return;
      var batch = rrwebEvents;
      rrwebEvents = [];
      sendChunk(batch, immediate);
    };
    var mutationSpamCounter = 0;
    var lastMutationSecond = Math.floor(Date.now() / 1e3);
    rrweb.record({
      emit: function(event) {
        if (event.type === 3) {
          var currentSecond = Math.floor(Date.now() / 1e3);
          if (currentSecond === lastMutationSecond) {
            mutationSpamCounter++;
            if (mutationSpamCounter > 50) return;
          } else {
            lastMutationSecond = currentSecond;
            mutationSpamCounter = 0;
          }
        }
        rrwebEvents.push(event);
        if (event.type === 2 || event.type === 4) {
          flushReplay();
        }
      },
      inlineStylesheet: true,
      recordCanvas: false,
      recordCrossOriginIframes: false,
      slimDOMOptions: "all",
      sampling: {
        mousemove: 200,
        // 5 FPS is enough
        scroll: 150,
        media: 800,
        input: "last"
      },
      maskAllInputs: true,
      maskTextFn: function(t) {
        return scrubPII(t);
      }
    });
    setInterval(flushReplay, 15e3);
    window.addEventListener("beforeunload", function() {
      flushReplay(true);
    });
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden") flushReplay(true);
    });
  }
  var hoverTarget = null;
  var hoverStart = 0;
  document.addEventListener("mouseover", function(e) {
    var target = e.target.closest('button, a, [role="button"], input, [data-sntnl]');
    if (target && target !== hoverTarget) {
      if (hoverTarget) {
        var duration = Date.now() - hoverStart;
        if (duration > 2e3) {
          enqueue("hover_friction", {
            tag: hoverTarget.tagName.toLowerCase(),
            text: (hoverTarget.innerText || "").slice(0, 50),
            duration
          });
        }
      }
      hoverTarget = target;
      hoverStart = Date.now();
    } else if (!target && hoverTarget) {
      var duration = Date.now() - hoverStart;
      if (duration > 2e3) {
        enqueue("hover_friction", {
          tag: hoverTarget.tagName.toLowerCase(),
          text: (hoverTarget.innerText || "").slice(0, 50),
          duration
        });
      }
      hoverTarget = null;
    }
  });
  document.addEventListener("click", function(e) {
    var target = e.target;
    var meaningful = target.closest('button, a, [role="button"], input, select, textarea, [data-sntnl]');
    if (!meaningful) {
      enqueue("click", {
        tag: target.tagName ? target.tagName.toLowerCase() : "unknown",
        dead_click: true,
        position: { x: e.pageX, y: e.pageY }
      });
    }
  }, true);
  document.addEventListener("copy", function() {
    if (!FEATURES.galactic_tracking) return;
    try {
      var selected = window.getSelection().toString();
      if (selected && selected.length > 2) {
        enqueue("copy", {
          copiedText: selected.slice(0, 150)
        });
      }
    } catch (e) {
    }
  });
  var backspaceCounts = {};
  document.addEventListener("keydown", function(e) {
    if (!FEATURES.galactic_tracking) return;
    if (e.key === "Backspace" || e.key === "Delete") {
      var target = e.target;
      if (target && target.tagName && (target.tagName.toLowerCase() === "input" || target.tagName.toLowerCase() === "textarea")) {
        if (target.type === "password" || target.name.toLowerCase().indexOf("card") !== -1) return;
        var fieldId = target.id || target.name || "unknown_field";
        backspaceCounts[fieldId] = (backspaceCounts[fieldId] || 0) + 1;
        if (backspaceCounts[fieldId] === 3) {
          enqueue("hesitation", {
            fieldType: target.type,
            fieldId,
            backspaceCount: backspaceCounts[fieldId]
          });
        }
      }
    }
  }, true);
  window.addEventListener("error", function(e) {
    if (!FEATURES.galactic_tracking) return;
    if (!e.message || typeof e.message !== "string") return;
    if (e.message.indexOf("rrweb") !== -1 || e.message.indexOf("sntnl") !== -1) return;
    enqueue("js_error", {
      errorMsg: e.message.slice(0, 200),
      source: typeof e.filename === "string" ? e.filename.split("/").pop() : "unknown",
      line: e.lineno,
      column: e.colno
    });
  });
  window.addEventListener("unhandledrejection", function(e) {
    if (!FEATURES.galactic_tracking) return;
    var msg = e.reason ? e.reason.message || e.reason.toString() : "Unknown promise rejection";
    if (msg.indexOf("rrweb") !== -1 || msg.indexOf("sntnl") !== -1) return;
    enqueue("js_error", {
      errorMsg: "Promise Rejection: " + msg.slice(0, 200)
    });
  });
  if (document.readyState === "complete") {
    setTimeout(startSessionReplay, 2e3);
  } else {
    window.addEventListener("load", function() {
      setTimeout(startSessionReplay, 2e3);
    });
  }
  function extractPrice(str) {
    if (!str) return null;
    var matches = str.match(/([0-9]{1,3}(?:[,. ][0-9]{3})*(?:[. ,][0-9]{2})?)/);
    if (!matches) return null;
    return parseFloat(matches[0].replace(/[ ,]/g, "").replace(",", "."));
  }
  function autoDetectRevenue() {
    var paths = ["/success", "/thank-you", "/confirmation", "/order-complete", "/done", "/checkout/paid"];
    var currentPath = location.pathname.toLowerCase();
    var isSuccessPage = paths.some(function(p) {
      return currentPath.indexOf(p) !== -1;
    });
    var revenue = null;
    var platform = "Generic";
    try {
      if (window.Shopify && window.Shopify.checkout) {
        revenue = window.Shopify.checkout.total_price;
        platform = "Shopify";
      } else if (window.WC_ORDER_DATA || document.querySelector(".woocommerce-thankyou-order-fixed")) {
        revenue = extractPrice(document.querySelector(".woocommerce-Price-amount")?.innerText);
        platform = "WooCommerce";
      } else if (window.dataLayer && Array.isArray(window.dataLayer)) {
        for (var i = window.dataLayer.length - 1; i >= 0; i--) {
          var dl = window.dataLayer[i];
          if (dl.ecommerce && dl.ecommerce.purchase && dl.ecommerce.purchase.actionField) {
            revenue = dl.ecommerce.purchase.actionField.revenue;
            platform = "DataLayer";
            break;
          }
        }
      }
    } catch (e) {
    }
    if (!revenue && isSuccessPage) {
      var selectors = [".total-price", ".order-total", ".amount-paid", "#total", '[class*="total"]'];
      for (var s = 0; s < selectors.length; s++) {
        var el = document.querySelector(selectors[s]);
        if (el && extractPrice(el.innerText)) {
          revenue = extractPrice(el.innerText);
          platform = "DOM-Scan";
          break;
        }
      }
    }
    if (revenue) {
      enqueue("purchase", {
        amount: parseFloat(revenue),
        platform,
        autoDetected: true,
        path: currentPath
      });
      flush();
    }
  }
  if (document.readyState === "complete") autoDetectRevenue();
  else window.addEventListener("load", autoDetectRevenue);
  setInterval(autoDetectRevenue, 1e4);
  function autoDiscover() {
    try {
      var urlParams = new URLSearchParams(window.location.search);
      var foundId = urlParams.get("email") || urlParams.get("uid") || urlParams.get("user_id");
      if (!foundId) {
        var authKeys = ["supabase.auth.token", "firebase:authUser", "ajs_user_id", "profile", "user"];
        for (var i = 0; i < authKeys.length; i++) {
          var val = localStorage.getItem(authKeys[i]);
          if (val) {
            try {
              if (val.indexOf("{") === 0) {
                var parsed = JSON.parse(val);
                foundId = parsed.email || parsed.id || parsed.user_id;
              } else {
                foundId = val;
              }
            } catch (e) {
            }
          }
          if (foundId) break;
        }
      }
      if (foundId) {
        var validId = validateIdentity(foundId);
        var current = localStorage.getItem("_sn_vid");
        if (validId && (!current || current !== validId)) {
          window.apstal.identify(validId);
        }
      }
    } catch (e) {
    }
  }
  var printFired = false;
  window.addEventListener("beforeprint", function() {
    if (printFired) return;
    printFired = true;
    enqueue("print_intent", {
      page: location.pathname,
      timeOnPage: Math.round((Date.now() - pageEnteredAt) / 1e3)
    });
    flush();
  });
  var devtoolsDetected = false;
  function checkDevTools() {
    if (devtoolsDetected) return;
    try {
      var el = new Image();
      Object.defineProperty(el, "id", {
        get: function() {
          devtoolsDetected = true;
          enqueue("devtools_open", {
            page: location.pathname,
            timeBeforeOpen: Math.round((Date.now() - pageEnteredAt) / 1e3)
          });
        }
      });
      console.log("%c", el);
    } catch (e) {
    }
  }
  setInterval(checkDevTools, 3e3);
  var lastScrollY_bi = 0;
  var scrollDirection_bi = 0;
  var scrollReversals = 0;
  window.addEventListener("scroll", function() {
    var y = window.scrollY || window.pageYOffset || 0;
    if (y === lastScrollY_bi) return;
    var dir = y > lastScrollY_bi ? 1 : -1;
    if (scrollDirection_bi !== 0 && dir !== scrollDirection_bi) {
      scrollReversals++;
    }
    scrollDirection_bi = dir;
    lastScrollY_bi = y;
  }, { passive: true });
  var sectionTimers = {};
  var sectionDwells = {};
  function setupSectionDwell() {
    if (!window.IntersectionObserver) return;
    var observer = new IntersectionObserver(function(entries) {
      for (var i2 = 0; i2 < entries.length; i2++) {
        var e = entries[i2];
        var id = e.target.id || e.target.getAttribute("data-section");
        if (!id) continue;
        if (e.isIntersecting) {
          sectionTimers[id] = Date.now();
        } else if (sectionTimers[id]) {
          var dwell = Math.round((Date.now() - sectionTimers[id]) / 1e3);
          if (dwell >= 1) sectionDwells[id] = dwell;
          delete sectionTimers[id];
        }
      }
    }, { threshold: 0.5 });
    var sections = document.querySelectorAll("section[id], [data-section], [id]");
    for (var i = 0; i < sections.length; i++) {
      var el = sections[i];
      var tag = el.tagName.toLowerCase();
      if (tag === "section" || tag === "div" || tag === "main" || tag === "article" || tag === "aside" || tag === "header" || tag === "footer" || tag === "nav") {
        observer.observe(el);
      }
    }
  }
  if (document.readyState === "complete") {
    setupSectionDwell();
  } else {
    window.addEventListener("load", setupSectionDwell);
  }
  var _origSendPageLeave = sendPageLeave;
  sendPageLeave = function() {
    var _origEnqueue = enqueue;
    enqueue = function(type, data) {
      if (type === "$mp_page_leave") {
        for (var id in sectionTimers) {
          var dwell = Math.round((Date.now() - sectionTimers[id]) / 1e3);
          if (dwell >= 1) sectionDwells[id] = dwell;
        }
        data.scroll_reversals = scrollReversals;
        if (Object.keys(sectionDwells).length > 0) {
          data.section_dwells = sectionDwells;
        }
      }
      _origEnqueue(type, data);
    };
    _origSendPageLeave();
    enqueue = _origEnqueue;
  };
  function checkBrokenAssets() {
    try {
      var images = document.querySelectorAll("img");
      var broken = [];
      for (var i = 0; i < images.length; i++) {
        var img = images[i];
        if (img.complete && img.naturalWidth === 0 && img.src) {
          broken.push(img.src.split("?")[0].split("/").pop());
        }
      }
      if (broken.length > 0) {
        enqueue("broken_assets", {
          count: broken.length,
          total: images.length,
          files: broken.slice(0, 10).join(","),
          page: location.pathname
        });
      }
    } catch (e) {
    }
  }
  if (document.readyState === "complete") {
    setTimeout(checkBrokenAssets, 2e3);
  } else {
    window.addEventListener("load", function() {
      setTimeout(checkBrokenAssets, 2e3);
    });
  }
  window.apstal = {
    trackForm: function(selector, type, data) {
      trackForm(selector, type, data);
    },
    // Block 5: Identity & Compliance
    identify: function(id) {
      if (!id) return;
      var oldId = VISITOR_ID;
      VISITOR_ID = id;
      localStorage.setItem("_sn_vid", id);
      enqueue("$identify", { $user_id: id, $anon_distinct_id: oldId });
      flush();
    },
    alias: function(alias, original) {
      original = original || VISITOR_ID;
      enqueue("$create_alias", { alias, distinct_id: original });
      flush();
    },
    timeEvent: function(name) {
      EVENT_TIMERS[name] = Date.now();
    },
    optOut: function() {
      localStorage.setItem("_sn_oo", "1");
      localStorage.removeItem("_sn_vid");
      localStorage.removeItem("_sn_sid");
      location.reload();
    },
    optIn: function() {
      localStorage.removeItem("_sn_oo");
    },
    track: function(type, data) {
      enqueue(type, data);
      flush();
    }
  };
  autoDiscover();
  var originalEnqueue = enqueue;
  enqueue = function(type, data) {
    if (type === "click" && (data.tag === "button" || data.tag === "a")) {
      var el = lastClickTarget;
      if (el) {
        var rev = checkRevenueSignals(el);
        if (rev) {
          originalEnqueue("revenue_intent", {
            amount: rev.amount,
            currency: rev.currency,
            elementText: data.text
          });
        }
      }
    }
    originalEnqueue(type, data);
  };
  document.addEventListener("click", checkRageClick, true);
  document.addEventListener("mousemove", checkConfusion, true);
  resetStagnation();
})();
