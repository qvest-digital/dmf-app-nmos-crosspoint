// Sign-in with OpenID Connect: config, claim mapping, and the whole code flow
// against a fake provider.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const express = require("express");
const jose = require("jose");
const o = require("../dist/lib/oidc.js");
const { WebsocketSyncServer } = require("../dist/lib/SyncServer/websocketSyncServer.js");

test("sign-in is off without issuer and client id; the rest has defaults", () => {
    assert.equal(o.parseOidcConfig(undefined), null);
    assert.equal(o.parseOidcConfig({ issuer: "https://idp.example" }), null);
    const c = o.parseOidcConfig({ issuer: "https://idp.example", clientId: "crosspoint" });
    assert.deepEqual(c.scopes, ["openid", "profile", "email"]);
    assert.equal(c.groupsClaim, "groups");
    assert.equal(c.sessionHours, 12);
});

test("groups come from defaultGroups and the mapped claim values", () => {
    const c = o.parseOidcConfig({
        issuer: "https://idp.example", clientId: "crosspoint",
        groupsClaim: "realm_access.roles",
        groupMap: { "xp-operator": ["user"], "xp-admin": ["user", "admin"] },
        defaultGroups: ["viewer"],
    });
    assert.deepEqual(o.groupsFor({ realm_access: { roles: ["xp-admin", "other"] } }, c), ["viewer", "user", "admin"]);
    assert.deepEqual(o.groupsFor({}, c), ["viewer"]);
    // A claim value that is not mapped grants nothing, even when it is a group name.
    assert.deepEqual(o.groupsFor({ realm_access: { roles: ["admin"] } }, { ...c, defaultGroups: [] }), []);
    assert.deepEqual(o.claimValues({ groups: "one" }, "groups"), ["one"]);
});

test("only a local path is returned to after sign-in", () => {
    assert.equal(o.safeReturnPath("/details?x=1"), "/details?x=1");
    for (const p of ["//evil.example", "/\\evil.example", "https://evil.example", "", undefined]) {
        assert.equal(o.safeReturnPath(p), "/", String(p));
    }
});

test("the origin follows a reverse proxy's forwarded headers", () => {
    assert.equal(o.requestOrigin({ headers: { host: "xp:80" } }), "http://xp:80");
    assert.equal(o.requestOrigin({ headers: { host: "xp", "x-forwarded-proto": "https, http", "x-forwarded-host": "xp.example" } }),
        "https://xp.example");
});

test("a session user is matched by group only, never by a local user's name", () => {
    const authData = {
        users: { admin: { password: "", groups: ["user"] } },
        permissions: {
            global: {
                allowRead: { users: ["admin"], groups: ["user"] }, allowWrite: { users: ["admin"], groups: ["user"] },
                denyRead: { users: [], groups: [] }, denyWrite: { users: [], groups: [] },
            },
        },
    };
    const check = (...a) => WebsocketSyncServer.prototype.checkPermission.call({ authData }, ...a);
    assert.equal(check("admin", "global", true), true);
    assert.equal(check("admin", "global", true, []), false);
    assert.equal(check("someone", "global", true, ["user"]), true);
});

// ----- the code flow against a fake provider -----

function listen(app) {
    return new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
}

// `token` overrides what the ID token is minted with: aud, iss, exp, or a
// key the provider does not publish.
async function fakeProvider(claims, token = {}) {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
    const signingKey = token.foreignKey ? (await jose.generateKeyPair("RS256")).privateKey : privateKey;
    const jwk = { ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const codes = new Map();
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    const idp = { requests: [] };
    app.get("/.well-known/openid-configuration", (req, res) => res.json({
        issuer: idp.url,
        authorization_endpoint: idp.url + "/auth",
        token_endpoint: idp.url + "/token",
        jwks_uri: idp.url + "/jwks",
        end_session_endpoint: idp.url + "/logout",
    }));
    app.get("/jwks", (req, res) => res.json({ keys: [jwk] }));
    app.post("/token", async (req, res) => {
        idp.requests.push({ body: req.body, authorization: req.headers.authorization });
        const c = codes.get(req.body.code);
        codes.delete(req.body.code);
        const challenge = crypto.createHash("sha256").update(req.body.code_verifier || "").digest("base64url");
        if (!c || challenge !== c.challenge || req.body.redirect_uri !== c.redirectUri) {
            res.status(400).json({ error: "invalid_grant" });
            return;
        }
        const idToken = await new jose.SignJWT({ nonce: c.nonce, ...claims })
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(token.iss || idp.url).setAudience(token.aud || "crosspoint").setSubject("u-1")
            .setIssuedAt(token.exp ? token.exp - 600 : undefined).setExpirationTime(token.exp || "5m").sign(signingKey);
        res.json({ id_token: idToken, token_type: "Bearer" });
    });
    // What the provider does when the user has signed in: hands out a code.
    idp.authorize = (location) => {
        const u = new URL(location);
        const code = crypto.randomBytes(8).toString("hex");
        codes.set(code, {
            nonce: u.searchParams.get("nonce"),
            challenge: u.searchParams.get("code_challenge"),
            redirectUri: u.searchParams.get("redirect_uri"),
        });
        return { code, state: u.searchParams.get("state"), params: u.searchParams };
    };
    idp.server = await listen(app);
    idp.url = "http://127.0.0.1:" + idp.server.address().port;
    return idp;
}

async function crosspoint(idp, extra = {}) {
    const signIn = new o.OidcSignIn(o.parseOidcConfig({
        issuer: idp.url, clientId: "crosspoint", groupMap: { operators: ["user"] }, ...extra,
    }));
    const app = express();
    signIn.mount(app);
    const server = await listen(app);
    return { signIn, server, url: "http://127.0.0.1:" + server.address().port };
}

const get = (url, cookie) => fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
// The WebSocket upgrade as the browser sends it from the crosspoint's page.
const upgrade = (xp, cookie, origin = xp.url) => ({ headers: { host: new URL(xp.url).host, origin, cookie } });
const setCookies = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]);

async function signInFlow(idp, xp) {
    const login = await get(xp.url + "/auth/oidc/login?return=/details");
    assert.equal(login.status, 302);
    const stateCookie = setCookies(login)[0];
    const auth = idp.authorize(login.headers.get("location"));
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    return { login, auth, cb, stateCookie };
}

test("the code flow signs a user in with PKCE and a session cookie", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });

    const { auth, cb } = await signInFlow(idp, xp);
    assert.equal(auth.params.get("code_challenge_method"), "S256");
    assert.equal(auth.params.get("redirect_uri"), xp.url + "/auth/oidc/callback");
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/details");
    // A public client sends its id and no secret.
    assert.equal(idp.requests[0].body.client_id, "crosspoint");
    assert.equal(idp.requests[0].authorization, undefined);

    const session = setCookies(cb).find((c) => c.startsWith(o.SESSION_COOKIE + "="));
    const who = xp.signIn.identify(upgrade(xp, session));
    assert.equal(who.user, "alice");
    assert.deepEqual(who.groups, ["user"]);
    // A page of another origin, on the same site or not, gets no session.
    assert.equal(xp.signIn.identify(upgrade(xp, session, "http://127.0.0.1:1")), null);
    assert.equal(xp.signIn.identify(upgrade(xp, session, "")), null);
    // The session ends with its time.
    assert.equal(xp.signIn.isActive(who.sessionId), true);
    assert.equal(xp.signIn.isActive(who.sessionId, Date.now() + 12 * 3600 * 1000 + 1), false);

    // Logout ends the session here and at the provider.
    let ended = "";
    xp.signIn.onLogout = (id) => { ended = id; };
    const out = await get(xp.url + "/auth/oidc/logout", session);
    assert.equal(out.status, 302);
    assert.ok(out.headers.get("location").startsWith(idp.url + "/logout?"));
    assert.equal(ended, who.sessionId);
    assert.equal(xp.signIn.identify(upgrade(xp, session)), null);
});

test("a confidential client authenticates at the token endpoint", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp, { clientSecret: "s3cret" });
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    assert.equal(cb.status, 302);
    assert.equal(idp.requests[0].authorization, "Basic " + Buffer.from("crosspoint:s3cret").toString("base64"));
});

test("a callback without the browser's state cookie is refused", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const login = await get(xp.url + "/auth/oidc/login");
    const auth = idp.authorize(login.headers.get("location"));
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state);
    assert.equal(cb.status, 400);
    assert.equal(idp.requests.length, 0);
});

test("an account with no mapped group gets no session", async (t) => {
    const idp = await fakeProvider({ preferred_username: "bob", groups: ["others"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    assert.equal(cb.status, 403);
    assert.equal(setCookies(cb).some((c) => c.startsWith(o.SESSION_COOKIE + "=")), false);
});

test("an ID token minted for another sign-in is refused", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"], nonce: "replayed" });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    assert.equal(cb.status, 502);
    assert.equal(setCookies(cb).some((c) => c.startsWith(o.SESSION_COOKIE + "=")), false);
});

test("an ID token for another client, from another issuer, signed by another key or expired is refused", async (t) => {
    for (const token of [{ aud: "other" }, { iss: "https://other.example" }, { foreignKey: true },
        { exp: Math.floor(Date.now() / 1000) - 60 }]) {
        const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] }, token);
        const xp = await crosspoint(idp);
        t.after(() => { idp.server.close(); xp.server.close(); });
        const { cb } = await signInFlow(idp, xp);
        assert.equal(cb.status, 502, JSON.stringify(token));
        assert.equal(setCookies(cb).some((c) => c.startsWith(o.SESSION_COOKIE + "=")), false, JSON.stringify(token));
    }
});

test("a callback is redeemed once", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { auth, cb, stateCookie } = await signInFlow(idp, xp);
    assert.equal(cb.status, 302);
    const again = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    assert.equal(again.status, 400);
});

test("an ID token for several audiences has to name this client as azp", async (t) => {
    for (const [claims, status] of [
        [{}, 502],
        [{ azp: "other" }, 502],
        [{ azp: "crosspoint" }, 302],
    ]) {
        const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"], ...claims },
            { aud: ["crosspoint", "other"] });
        const xp = await crosspoint(idp);
        t.after(() => { idp.server.close(); xp.server.close(); });
        const { cb } = await signInFlow(idp, xp);
        assert.equal(cb.status, status, JSON.stringify(claims));
    }
    // One audience needs no azp.
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    assert.equal((await signInFlow(idp, xp)).cb.status, 302);
});

test("a sign-in left unfinished expires", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const login = await get(xp.url + "/auth/oidc/login");
    const stateCookie = setCookies(login)[0];
    const auth = idp.authorize(login.headers.get("location"));
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 10 * 60 * 1000 + 1 });
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    t.mock.timers.reset();
    assert.equal(cb.status, 400);
    assert.equal(idp.requests.length, 0, "the code is never redeemed");
});

test("a full list of sign-ins in progress refuses a new one and keeps the others", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const first = await get(xp.url + "/auth/oidc/login");
    const stateCookie = setCookies(first)[0];
    const auth = idp.authorize(first.headers.get("location"));
    for (let i = 1; i < 1000; i++) {
        assert.equal((await get(xp.url + "/auth/oidc/login")).status, 302);
    }
    assert.equal((await get(xp.url + "/auth/oidc/login")).status, 503);
    // The first one, started before the flood, still completes.
    const cb = await get(xp.url + "/auth/oidc/callback?code=" + auth.code + "&state=" + auth.state, stateCookie);
    assert.equal(cb.status, 302);
});

test("logout is refused from another site's page", async (t) => {
    const idp = await fakeProvider({ preferred_username: "alice", groups: ["operators"] });
    const xp = await crosspoint(idp);
    t.after(() => { idp.server.close(); xp.server.close(); });
    const { cb } = await signInFlow(idp, xp);
    const session = setCookies(cb).find((c) => c.startsWith(o.SESSION_COOKIE + "="));
    const logout = (site) => fetch(xp.url + "/auth/oidc/logout",
        { redirect: "manual", headers: { cookie: session, "sec-fetch-site": site } });
    for (const site of ["cross-site", "same-site"]) {
        assert.equal((await logout(site)).status, 403, site);
        assert.notEqual(xp.signIn.identify(upgrade(xp, session)), null, "still signed in after " + site);
    }
    assert.equal((await logout("same-origin")).status, 302);
    assert.equal(xp.signIn.identify(upgrade(xp, session)), null);
});

test("a local login replaces the socket's identity, and a failed one signs it out", () => {
    const { WebsocketClient } = require("../dist/lib/SyncServer/websocketClient.js");
    const saved = WebsocketSyncServer.instance;
    WebsocketSyncServer.instance = { authData: { users: { bob: { password: "pw", groups: ["user"] } } } };
    try {
        const sent = [];
        const socket = { user: "alice", groups: ["admin"], sessionId: "s-1", authSeed: "seed", send: (m) => sent.push(m) };
        WebsocketClient.prototype.processAuth.call(socket, { user: "bob", password: "wrong" });
        assert.deepEqual([socket.user, socket.groups, socket.sessionId], ["__noAuth", null, ""]);
        assert.equal(sent.pop().type, "authfailed");

        const proof = crypto.createHash("sha256").update("pw" + "seed").digest("hex");
        Object.assign(socket, { groups: ["admin"], sessionId: "s-2" });
        WebsocketClient.prototype.processAuth.call(socket, { user: "bob", password: proof });
        assert.deepEqual([socket.user, socket.groups, socket.sessionId], ["bob", null, ""],
            "a local user's groups come from users.json, not from the session it replaced");
    } finally {
        WebsocketSyncServer.instance = saved;
    }
});
