/* Sign-in and data loading for The Internet Coaches Dashboard.
 *
 * Users live in Amazon Cognito. The browser talks to Cognito directly (plain
 * JSON calls, no SDK) to sign in, change a temporary password, reset a
 * forgotten one and refresh tokens. With an ID token in hand it asks the
 * dashboard API which stores the user may see and gets short-lived links to
 * one private JSON per store, fetches those, merges them into window.DASH_DATA
 * and only then boots the app. Nothing about a store reaches a browser that is
 * not allowed to see it.
 */
(function (global) {
  "use strict";

  var CFG = {
    region: "us-east-1",
    poolId: "us-east-1_rjZw65GZW",
    clientId: "43j5smkbt4mmlhuv58uaa7d4rd",
    api: "https://us6ecor41h.execute-api.us-east-1.amazonaws.com"
  };
  var KEY = "icdash.auth";
  var state = { tokens: null, user: null, pendingSession: null, pendingUser: null };

  /* ------------------------------------------------------------ storage */
  function load() {
    try { state.tokens = JSON.parse(global.localStorage.getItem(KEY) || "null"); } catch (e) { state.tokens = null; }
    return state.tokens;
  }
  function save(t) {
    state.tokens = t;
    try {
      if (t) global.localStorage.setItem(KEY, JSON.stringify(t)); else global.localStorage.removeItem(KEY);
    } catch (e) { /* private mode: the session lives in memory only */ }
  }

  /* --------------------------------------------------------- cognito api */
  function idp(target, body) {
    return fetch("https://cognito-idp." + CFG.region + ".amazonaws.com/", {
      method: "POST",
      headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService." + target },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error(j.message || j.__type || "Sign-in failed");
          err.code = (j.__type || "").split("#").pop();
          throw err;
        }
        return j;
      });
    });
  }

  function acceptAuth(result) {
    if (!result || !result.IdToken) throw new Error("No token returned");
    var t = {
      id: result.IdToken, access: result.AccessToken,
      refresh: result.RefreshToken || (state.tokens && state.tokens.refresh) || null,
      exp: Date.now() + ((result.ExpiresIn || 3600) - 60) * 1000
    };
    save(t);
    return t;
  }

  function signIn(email, password) {
    return idp("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH", ClientId: CFG.clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password }
    }).then(function (res) {
      if (res.ChallengeName === "NEW_PASSWORD_REQUIRED") {
        state.pendingSession = res.Session;
        state.pendingUser = email;
        return { challenge: "newPassword" };
      }
      acceptAuth(res.AuthenticationResult);
      return { ok: true };
    });
  }

  function completeNewPassword(newPassword) {
    return idp("RespondToAuthChallenge", {
      ChallengeName: "NEW_PASSWORD_REQUIRED", ClientId: CFG.clientId, Session: state.pendingSession,
      ChallengeResponses: { USERNAME: state.pendingUser, NEW_PASSWORD: newPassword }
    }).then(function (res) {
      state.pendingSession = null;
      acceptAuth(res.AuthenticationResult);
      return { ok: true };
    });
  }

  function forgotPassword(email) {
    return idp("ForgotPassword", { ClientId: CFG.clientId, Username: email });
  }
  function confirmForgot(email, code, password) {
    return idp("ConfirmForgotPassword", { ClientId: CFG.clientId, Username: email, ConfirmationCode: code, Password: password });
  }

  function refresh() {
    if (!state.tokens || !state.tokens.refresh) return Promise.reject(new Error("no refresh token"));
    return idp("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: CFG.clientId,
      AuthParameters: { REFRESH_TOKEN: state.tokens.refresh }
    }).then(function (res) { return acceptAuth(res.AuthenticationResult); });
  }

  function validToken() {
    if (!state.tokens) return Promise.reject(new Error("signed out"));
    if (Date.now() < state.tokens.exp) return Promise.resolve(state.tokens.id);
    return refresh().then(function (t) { return t.id; });
  }

  function signOut() {
    save(null);
    state.user = null;
    global.DASH_DATA = null;
    global.DASH_USER = null;
    showLogin("signin");
  }

  /* ------------------------------------------------------- dashboard api */
  function api(path, opts) {
    opts = opts || {};
    return validToken().then(function (tok) {
      var init = { method: opts.method || "GET", headers: { Authorization: "Bearer " + tok } };
      if (opts.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
      return fetch(CFG.api + path, init);
    }).then(function (r) {
      if (r.status === 401) {
        return refresh().then(function () { return api(path, Object.assign({}, opts, { _retried: true })); });
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ("Request failed (" + r.status + ")")); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("Data file failed (" + r.status + ")");
      return r.json();
    });
  }

  /* Merge meta + the allowed store files into the DASH_DATA shape core.js expects. */
  function loadData() {
    return api("/data").then(function (grant) {
      var allowed = {};
      (grant.storeIds || []).forEach(function (id) { allowed[id] = 1; });
      return Promise.all([fetchJson(grant.meta)].concat(grant.files.map(function (f) { return fetchJson(f.url); })))
        .then(function (parts) {
          var meta = parts[0];
          var data = {};
          for (var k in meta) if (k !== "storeFiles") data[k] = meta[k];
          data.stores = (meta.stores || []).filter(function (s) { return allowed[s.id]; });
          data.groups = (meta.groups || []).map(function (g) {
            return { id: g.id, name: g.name, storeIds: (g.storeIds || []).filter(function (id) { return allowed[id]; }) };
          }).filter(function (g) { return g.storeIds.length; });
          data.snapshots = []; data.matador = []; data.covideo = []; data.repGoals = []; data.coverage = {};
          parts.slice(1).forEach(function (sf) {
            data.snapshots = data.snapshots.concat(sf.snapshots || []);
            data.matador = data.matador.concat(sf.matador || []);
            data.covideo = data.covideo.concat(sf.covideo || []);
            data.repGoals = data.repGoals.concat(sf.repGoals || []);
            if (sf.coverage) data.coverage[sf.storeId] = sf.coverage;
          });
          if (!grant.admin) delete data.runs;   // the Logs page is for admins
          global.DASH_DATA = data;
          global.DASH_USER = { email: grant.email, name: grant.name, admin: !!grant.admin, storeIds: grant.storeIds || [] };
          state.user = global.DASH_USER;
          return data;
        });
    });
  }

  /* ----------------------------------------------------------- passkeys
     Touch ID / Face ID / Windows Hello through WebAuthn. Cognito issues the
     options, the browser's authenticator signs them, Cognito verifies. A
     passkey is registered once per device after a normal sign-in. */
  var LAST_EMAIL = "icdash.lastEmail";
  function b64uToBuf(str) {
    str = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function bufToB64u(buf) {
    var bytes = new Uint8Array(buf), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function passkeysSupported() {
    return !!(global.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }
  function parseJsonMaybe(v) { return typeof v === "string" ? JSON.parse(v) : v; }

  function toCreationOptions(o) {
    o = parseJsonMaybe(o);
    var pk = o.publicKey || o;
    pk.challenge = b64uToBuf(pk.challenge);
    pk.user.id = b64uToBuf(pk.user.id);
    (pk.excludeCredentials || []).forEach(function (c) { c.id = b64uToBuf(c.id); });
    return { publicKey: pk };
  }
  function toRequestOptions(o) {
    o = parseJsonMaybe(o);
    var pk = o.publicKey || o;
    pk.challenge = b64uToBuf(pk.challenge);
    (pk.allowCredentials || []).forEach(function (c) { c.id = b64uToBuf(c.id); });
    return { publicKey: pk };
  }
  function credentialJson(cred) {
    var r = cred.response, out = {
      id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
    };
    if (r.attestationObject) {
      out.response.attestationObject = bufToB64u(r.attestationObject);
      if (r.getTransports) out.response.transports = r.getTransports();
    }
    if (r.authenticatorData) {
      out.response.authenticatorData = bufToB64u(r.authenticatorData);
      out.response.signature = bufToB64u(r.signature);
      if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
    }
    return out;
  }

  /* Register this device's Touch ID / Face ID for the signed-in user. */
  function registerPasskey() {
    if (!passkeysSupported()) return Promise.reject(new Error("This browser does not support passkeys."));
    return validToken().then(function () {
      return idp("StartWebAuthnRegistration", { AccessToken: state.tokens.access });
    }).then(function (res) {
      return navigator.credentials.create(toCreationOptions(res.CredentialCreationOptions));
    }).then(function (cred) {
      return idp("CompleteWebAuthnRegistration", { AccessToken: state.tokens.access, Credential: credentialJson(cred) });
    }).then(function () {
      try { global.localStorage.setItem("icdash.passkey", "1"); } catch (e) { /* ignore */ }
      return true;
    });
  }

  function listPasskeys() {
    return validToken().then(function () { return idp("ListWebAuthnCredentials", { AccessToken: state.tokens.access, MaxResults: 20 }); })
      .then(function (res) { return res.Credentials || []; });
  }

  /* Sign in with a passkey: Cognito's USER_AUTH flow, WEB_AUTHN challenge. */
  function signInWithPasskey(email) {
    if (!passkeysSupported()) return Promise.reject(new Error("This browser does not support passkeys."));
    return idp("InitiateAuth", {
      AuthFlow: "USER_AUTH", ClientId: CFG.clientId,
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "WEB_AUTHN" }
    }).then(function (res) {
      if (res.ChallengeName !== "WEB_AUTHN") {
        var e = new Error("No passkey is set up for this email on Cognito. Sign in with your password first, then enable Touch ID.");
        e.code = "NoPasskey";
        throw e;
      }
      var opts = toRequestOptions(res.ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS);
      return navigator.credentials.get(opts).then(function (cred) {
        return idp("RespondToAuthChallenge", {
          ChallengeName: "WEB_AUTHN", ClientId: CFG.clientId, Session: res.Session,
          ChallengeResponses: { USERNAME: email, CREDENTIAL: JSON.stringify(credentialJson(cred)) }
        });
      });
    }).then(function (res) {
      acceptAuth(res.AuthenticationResult);
      return { ok: true };
    });
  }

  /* ---------------------------------------------------------------- ui */
  var FORMS = {
    loading: '<div class="lg-loading" aria-live="polite"><span class="lg-spinner" aria-hidden="true"></span><p class="lg-sub">Loading your dashboard\u2026</p></div>',
    signin: '<h1>Internet Coaches Dashboard</h1><p class="lg-sub">Sign in with the email you were invited with.</p>' +
      '<label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>' +
      '<label>Password<input type="password" name="password" autocomplete="current-password" required></label>' +
      '<button type="submit" class="lg-btn">Sign in</button>' +
      '<button type="button" class="lg-btn lg-alt" data-passkey hidden>Sign in with Touch ID / Face ID</button>' +
      '<button type="button" class="lg-link" data-go="forgot">Forgot your password?</button>',
    newPassword: '<h1>Choose a new password</h1><p class="lg-sub">Your temporary password worked. Pick the one you will use from now on (10+ characters, upper and lower case, a number).</p>' +
      '<label>New password<input type="password" name="password" autocomplete="new-password" required minlength="10" autofocus></label>' +
      '<label>Repeat it<input type="password" name="password2" autocomplete="new-password" required minlength="10"></label>' +
      '<button type="submit" class="lg-btn">Save and continue</button>',
    forgot: '<h1>Reset your password</h1><p class="lg-sub">We will email you a code.</p>' +
      '<label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>' +
      '<button type="submit" class="lg-btn">Send code</button>' +
      '<button type="button" class="lg-link" data-go="signin">Back to sign in</button>',
    confirm: '<h1>Enter the code</h1><p class="lg-sub">Check your email for a 6-digit code, then choose a new password.</p>' +
      '<label>Email<input type="email" name="email" autocomplete="username" required></label>' +
      '<label>Code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>' +
      '<label>New password<input type="password" name="password" autocomplete="new-password" required minlength="10"></label>' +
      '<button type="submit" class="lg-btn">Set password</button>' +
      '<button type="button" class="lg-link" data-go="signin">Back to sign in</button>'
  };

  function el(id) { return document.getElementById(id); }

  function showLogin(mode, message, prefillEmail) {
    var box = el("login");
    if (!box) return;
    box.hidden = false;
    document.body.classList.add("locked");
    var form = box.querySelector("form");
    form.setAttribute("data-mode", mode);
    form.innerHTML = FORMS[mode] + '<p class="lg-msg" role="alert"></p>';
    if (message) setMsg(message.text, message.kind);
    var remembered = null;
    try { remembered = global.localStorage.getItem(LAST_EMAIL); } catch (e) { remembered = null; }
    if (prefillEmail || remembered) { var em = form.querySelector('[name=email]'); if (em && !em.value) em.value = prefillEmail || remembered; }
    var pkBtn = form.querySelector("[data-passkey]");
    if (pkBtn && passkeysSupported()) pkBtn.hidden = false;
    var first = form.querySelector("[autofocus]");
    if (first) setTimeout(function () { first.focus(); }, 0);
  }
  function hideLogin() {
    var box = el("login");
    if (box) box.hidden = true;
    document.body.classList.remove("locked");
  }
  function setMsg(text, kind) {
    var m = document.querySelector("#login .lg-msg");
    if (!m) return;
    m.textContent = text || "";
    m.className = "lg-msg" + (kind ? " " + kind : "");
  }
  function busy(on) {
    var b = document.querySelector("#login button[type=submit]");
    if (b) { b.disabled = !!on; b.textContent = on ? "Please wait…" : b.getAttribute("data-label") || b.textContent; }
  }

  function friendly(err) {
    var c = err && err.code;
    if (c === "NotAuthorizedException") return "Wrong email or password.";
    if (c === "UserNotFoundException") return "No login with that email.";
    if (c === "PasswordResetRequiredException") return "Your password must be reset. Use “Forgot your password”.";
    if (c === "InvalidPasswordException") return "That password does not meet the rules: 10+ characters, upper and lower case, a number.";
    if (c === "CodeMismatchException") return "That code is not right.";
    if (c === "ExpiredCodeException") return "That code expired. Request a new one.";
    if (c === "LimitExceededException") return "Too many attempts. Wait a few minutes.";
    if (c === "UserNotConfirmedException") return "This login is not confirmed yet. Ask an admin to resend the invite.";
    return (err && err.message) || "Something went wrong.";
  }

  function wireLogin() {
    var box = el("login");
    if (!box) return;
    var form = box.querySelector("form");
    form.addEventListener("click", function (ev) {
      var go = ev.target.getAttribute && ev.target.getAttribute("data-go");
      if (go) showLogin(go);
      if (ev.target.hasAttribute && ev.target.hasAttribute("data-passkey")) {
        var email = (form.elements.email.value || "").trim().toLowerCase();
        if (!email) { setMsg("Type your email first, then use Touch ID.", "bad"); form.elements.email.focus(); return; }
        setMsg("");
        ev.target.disabled = true;
        signInWithPasskey(email).then(function () {
          try { global.localStorage.setItem(LAST_EMAIL, email); } catch (e) { /* ignore */ }
          return afterSignIn();
        }).catch(function (err) {
          setMsg(err && err.name === "NotAllowedError" ? "Touch ID was cancelled." : friendly(err), "bad");
        }).then(function () { ev.target.disabled = false; });
      }
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var mode = form.getAttribute("data-mode");
      var f = form.elements;
      setMsg("");
      busy(true);
      var p;
      if (mode === "signin") {
        var email = f.email.value.trim().toLowerCase();
        p = signIn(email, f.password.value).then(function (r) {
          try { global.localStorage.setItem(LAST_EMAIL, email); } catch (e) { /* ignore */ }
          if (r.challenge === "newPassword") { showLogin("newPassword"); return null; }
          return afterSignIn();
        });
      } else if (mode === "newPassword") {
        if (f.password.value !== f.password2.value) { busy(false); setMsg("The two passwords differ.", "bad"); return; }
        p = completeNewPassword(f.password.value).then(afterSignIn);
      } else if (mode === "forgot") {
        var em2 = f.email.value.trim().toLowerCase();
        p = forgotPassword(em2).then(function () {
          showLogin("confirm", { text: "Code sent. Check your inbox (and spam).", kind: "good" }, em2);
        });
      } else if (mode === "confirm") {
        var em3 = f.email.value.trim().toLowerCase();
        p = confirmForgot(em3, f.code.value.trim(), f.password.value).then(function () {
          showLogin("signin", { text: "Password set. Sign in with it.", kind: "good" }, em3);
        });
      }
      (p || Promise.resolve()).catch(function (err) { setMsg(friendly(err), "bad"); }).then(function () { busy(false); });
    });
  }

  function afterSignIn() {
    setMsg("Loading your stores…", "good");
    return loadData().then(function () {
      hideLogin();
      if (global.App && global.App.boot) global.App.boot();
    });
  }

  /* --------------------------------------------------------------- boot */
  function start() {
    wireLogin();
    load();
    if (!state.tokens) { showLogin("signin"); return; }
    // A returning user never sees the sign-in form: a quiet splash while the
    // token is refreshed and the data loads, then straight into the dashboard.
    showLogin("loading");
    loadData().then(function () {
      hideLogin();
      if (global.App && global.App.boot) global.App.boot();
    }).catch(function (err) {
      save(null);
      showLogin("signin", { text: err && err.status === 403 ? "Access denied." : "Please sign in again.", kind: "" });
    });
  }

  global.Auth = {
    start: start, signOut: signOut, api: api, reload: loadData, user: function () { return state.user; }, config: CFG,
    passkeysSupported: passkeysSupported, registerPasskey: registerPasskey, listPasskeys: listPasskeys
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}(typeof window !== "undefined" ? window : this));
