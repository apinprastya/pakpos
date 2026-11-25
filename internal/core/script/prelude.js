// Pakpos script prelude: builds pm, console and the sandbox globals for one
// script run. The program's value is a function Go calls with the host
// functions, the input (as JSON) and the expect library; it returns
// {drain, finish}: drain runs waiting callbacks, finish reports the run's
// state (as JSON) back to Go. The host
// object stays in this closure, so scripts can't reach it.
(function (host, inputJSON, lib) {
  "use strict";

  var input = JSON.parse(inputJSON);
  var expect = lib.expect;
  var g = globalThis;
  var state = { request: input.request, nextRequest: null, nextRequestSet: false, skip: false };
  // Callbacks of pm.sendRequest and the cookie jar run after the script's
  // own code, as in Postman (Go calls drain until none are left).
  var pending = [];

  function str(v) {
    if (v === undefined) return "";
    if (typeof v === "string") return v;
    if (v !== null && typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function lc(s) {
    return String(s).toLowerCase();
  }

  function fail(message) {
    throw new Error(message);
  }

  // ---- variables ----

  function scope(kind, label) {
    var setKind = kind === "" ? "local" : kind;
    return {
      get: function (key) {
        return host.varGet(kind, str(key));
      },
      has: function (key) {
        return host.varGet(kind, str(key)) !== undefined;
      },
      set: function (key, value) {
        if (arguments.length < 1 || str(key).trim() === "") fail(label + ".set needs a variable name");
        host.varSet(setKind, str(key), str(value));
      },
      unset: function (key) {
        host.varUnset(setKind, str(key));
      },
      toObject: function () {
        return JSON.parse(host.varAll(kind));
      },
      replaceIn: function (text) {
        return host.replaceIn(str(text));
      },
    };
  }

  var environment = scope("environment", "pm.environment");
  environment.name = input.environmentName;

  // ---- request ----

  var req = state.request;
  var mutable = input.event === "prerequest";

  function guard() {
    if (!mutable) fail("pm.request can only be changed in a pre-request script");
  }

  function toHeader(h, value) {
    if (typeof h === "string" && value !== undefined) return { key: h, value: str(value) };
    if (typeof h === "string") {
      var i = h.indexOf(":");
      return i < 0 ? { key: h.trim(), value: "" } : { key: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
    }
    if (h === null || typeof h !== "object") fail("A header needs a key and a value, like {key: 'X-Id', value: '1'}");
    return { key: str(h.key), value: str(h.value) };
  }

  function enabledHeaders() {
    return req.headers.filter(function (h) {
      return h.enabled && h.key.trim() !== "";
    });
  }

  function headerList(rows) {
    return {
      get: function (name) {
        var n = lc(name), v;
        rows().forEach(function (h) {
          if (lc(h.key) === n) v = h.value;
        });
        return v;
      },
      has: function (name, value) {
        var n = lc(name);
        return rows().some(function (h) {
          return lc(h.key) === n && (value === undefined || h.value === str(value));
        });
      },
      each: function (fn) {
        rows().forEach(function (h) {
          fn({ key: h.key, value: h.value });
        });
      },
      all: function () {
        return rows().map(function (h) {
          return { key: h.key, value: h.value };
        });
      },
      count: function () {
        return rows().length;
      },
      toObject: function () {
        var o = {};
        rows().forEach(function (h) {
          o[h.key] = h.value;
        });
        return o;
      },
    };
  }

  var reqHeaders = headerList(enabledHeaders);
  reqHeaders.add = function (h, value) {
    guard();
    var row = toHeader(h, value);
    req.headers.push({ key: row.key, value: row.value, enabled: true });
  };
  reqHeaders.upsert = function (h, value) {
    guard();
    var row = toHeader(h, value), n = lc(row.key), done = false;
    req.headers = req.headers.filter(function (x) {
      if (!x.enabled || lc(x.key) !== n) return true;
      if (done) return false;
      x.value = row.value;
      done = true;
      return true;
    });
    if (!done) req.headers.push({ key: row.key, value: row.value, enabled: true });
  };
  reqHeaders.remove = function (name) {
    guard();
    var n = lc(typeof name === "object" && name !== null ? name.key : name);
    req.headers = req.headers.filter(function (x) {
      return lc(x.key) !== n;
    });
  };

  function splitURL(u) {
    var hash = "", i = u.indexOf("#");
    if (i >= 0) {
      hash = u.slice(i);
      u = u.slice(0, i);
    }
    var q = "";
    i = u.indexOf("?");
    if (i >= 0) {
      q = u.slice(i + 1);
      u = u.slice(0, i);
    }
    return { base: u, query: q, hash: hash };
  }

  function decode(s) {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch (e) {
      return s;
    }
  }

  function queryPairs(params) {
    if (typeof params === "string") return params.split("&").filter(Boolean);
    if (!Array.isArray(params)) params = [params];
    return params.map(function (p) {
      if (typeof p === "string") return p;
      return encodeURIComponent(str(p.key)) + (p.value === undefined || p.value === null ? "" : "=" + encodeURIComponent(str(p.value)));
    });
  }

  var url = {
    toString: function () {
      return req.url;
    },
    toJSON: function () {
      return req.url;
    },
    valueOf: function () {
      return req.url;
    },
    getQueryString: function () {
      return splitURL(req.url).query;
    },
    addQueryParams: function (params) {
      guard();
      var p = splitURL(req.url);
      var pairs = (p.query ? p.query.split("&") : []).concat(queryPairs(params));
      req.url = p.base + (pairs.length ? "?" + pairs.join("&") : "") + p.hash;
    },
    removeQueryParams: function (names) {
      guard();
      var list = (Array.isArray(names) ? names : [names]).map(function (n) {
        return typeof n === "object" && n !== null ? str(n.key) : str(n);
      });
      var p = splitURL(req.url);
      var pairs = (p.query ? p.query.split("&") : []).filter(function (pair) {
        return list.indexOf(decode(pair.split("=")[0])) < 0;
      });
      req.url = p.base + (pairs.length ? "?" + pairs.join("&") : "") + p.hash;
    },
  };

  var bodyModes = { raw: "raw", "form-data": "formdata", urlencoded: "urlencoded", binary: "file", none: "none" };
  var body = {
    toString: function () {
      if (req.body.type === "raw") return req.body.raw;
      if (req.body.type === "urlencoded") {
        return (req.body.urlEncoded || [])
          .filter(function (r) {
            return r.enabled;
          })
          .map(function (r) {
            return encodeURIComponent(r.key) + "=" + encodeURIComponent(r.value);
          })
          .join("&");
      }
      return "";
    },
    update: function (v) {
      guard();
      req.body.raw = str(v);
      if (req.body.type !== "raw") req.body.type = "raw";
    },
  };
  Object.defineProperty(body, "mode", {
    enumerable: true,
    get: function () {
      return bodyModes[req.body.type] || "none";
    },
  });
  Object.defineProperty(body, "raw", {
    enumerable: true,
    get: function () {
      return req.body.raw || "";
    },
    set: function (v) {
      body.update(v);
    },
  });

  var request = { headers: reqHeaders, body: body, id: req.id, name: req.name };
  Object.defineProperty(request, "method", {
    enumerable: true,
    get: function () {
      return req.method;
    },
    set: function (v) {
      guard();
      req.method = str(v).trim().toUpperCase();
    },
  });
  Object.defineProperty(request, "url", {
    enumerable: true,
    get: function () {
      return url;
    },
    set: function (v) {
      guard();
      req.url = str(v);
    },
  });

  // ---- response ----

  function makeResponse(r) {
    var res = {
      code: r.code,
      status: r.status,
      responseTime: r.responseTime,
      responseSize: r.responseSize,
      headers: headerList(function () {
        return r.headers;
      }),
      text: function () {
        return r.body;
      },
      json: function () {
        try {
          return JSON.parse(r.body);
        } catch (e) {
          throw new SyntaxError("JSONError: " + e.message + " (the response body isn't valid JSON)");
        }
      },
    };
    Object.defineProperty(res, "__pmResponse", { value: true });
    Object.defineProperty(res, "to", {
      get: function () {
        return expect(res).to;
      },
    });
    return res;
  }

  // ---- tests ----

  function errorText(e) {
    if (e !== null && typeof e === "object" && "message" in e) return (e.name || "Error") + ": " + e.message;
    return String(e);
  }

  function test(name, fn) {
    name = str(name);
    if (typeof fn !== "function") {
      host.test(name, false, "", true);
      return pm;
    }
    var r;
    try {
      r = fn();
    } catch (e) {
      host.test(name, false, errorText(e), false);
      return pm;
    }
    if (r !== null && typeof r === "object" && typeof r.then === "function") {
      // An async test passes or fails when its promise settles.
      r.then(
        function () {
          host.test(name, true, "", false);
        },
        function (e) {
          host.test(name, false, errorText(e), false);
        },
      );
      return pm;
    }
    host.test(name, true, "", false);
    return pm;
  }
  test.skip = function (name) {
    host.test(str(name), false, "", true);
    return pm;
  };

  // ---- async results ----

  // settle runs work now and hands its result to cb (later, after the
  // script's own code) or, without a callback, returns a promise.
  function settle(cb, work) {
    var err = null, value;
    try {
      value = work();
    } catch (e) {
      err = e;
    }
    if (typeof cb === "function") {
      pending.push(function () {
        cb(err, value);
      });
      return undefined;
    }
    return err === null ? Promise.resolve(value) : Promise.reject(err);
  }

  // ---- pm.sendRequest ----

  function rows(list, what) {
    if (list === undefined || list === null) return [];
    if (typeof list === "string") list = list.split("\n").filter(function (l) {
      return l.trim() !== "";
    });
    if (!Array.isArray(list)) {
      if (typeof list !== "object") fail(what + " must be a list of {key, value} rows or an object");
      return Object.keys(list).map(function (k) {
        return { key: k, value: str(list[k]), enabled: true };
      });
    }
    return list.map(function (h) {
      var row = toHeader(h);
      return { key: row.key, value: row.value, enabled: !(h && h.disabled) };
    });
  }

  function authParams(a, type) {
    var p = a[type], o = {};
    if (Array.isArray(p)) {
      p.forEach(function (x) {
        if (x && x.key !== undefined) o[str(x.key)] = x.value;
      });
      return o;
    }
    return p && typeof p === "object" ? p : {};
  }

  function toAuth(a) {
    if (a === undefined || a === null) return { type: "none" };
    var type = str(a.type);
    var p = authParams(a, type);
    switch (type) {
      case "noauth":
      case "none":
        return { type: "none" };
      case "basic":
        return { type: "basic", username: str(p.username), password: str(p.password) };
      case "bearer":
        return { type: "bearer", token: str(p.token) };
      case "apikey":
        return { type: "apikey", apiKey: str(p.key), apiValue: str(p.value), apiIn: p["in"] === "query" ? "query" : "header" };
    }
    fail("pm.sendRequest supports basic, bearer and apikey auth, not \"" + type + "\". Set the Authorization header yourself.");
  }

  function toBody(b) {
    var none = { type: "none", raw: "", language: "", formData: [], urlEncoded: [], binaryPath: "" };
    if (b === undefined || b === null) return none;
    if (typeof b === "string") return Object.assign(none, { type: "raw", raw: b, language: "text" });
    var lang = (b.options && b.options.raw && b.options.raw.language) || "text";
    switch (b.mode) {
      case undefined:
      case "none":
        return none;
      case "raw":
        return Object.assign(none, { type: "raw", raw: str(b.raw), language: str(lang) });
      case "graphql":
        var gql = b.graphql || {};
        var variables = gql.variables;
        if (typeof variables === "string") {
          try {
            variables = variables.trim() === "" ? undefined : JSON.parse(variables);
          } catch (e) {
            fail("The GraphQL variables aren't valid JSON: " + e.message);
          }
        }
        return Object.assign(none, {
          type: "raw",
          raw: JSON.stringify({ query: str(gql.query), variables: variables }),
          language: "json",
        });
      case "urlencoded":
        return Object.assign(none, { type: "urlencoded", urlEncoded: rows(b.urlencoded, "body.urlencoded") });
      case "formdata":
        var fields = (Array.isArray(b.formdata) ? b.formdata : []).map(function (f) {
          if (f && (f.type === "file" || f.src !== undefined)) fail("pm.sendRequest can't upload files");
          return { key: str(f && f.key), kind: "text", value: str(f && f.value), filePath: "", contentType: str(f && f.contentType), enabled: !(f && f.disabled) };
        });
        return Object.assign(none, { type: "form-data", formData: fields });
    }
    fail("pm.sendRequest can't send a body in \"" + str(b.mode) + "\" mode; use raw, urlencoded, formdata or graphql");
  }

  function toRequest(r) {
    if (typeof r === "string") r = { url: r };
    if (r === null || typeof r !== "object") fail("pm.sendRequest needs a URL or a request like {url, method, header, body}");
    var u = r.url;
    if (u !== null && typeof u === "object") u = u.raw !== undefined ? u.raw : u.toString();
    u = str(u).trim();
    if (u === "") fail("pm.sendRequest needs a URL");
    return {
      method: str(r.method || "GET").trim().toUpperCase(),
      url: u,
      headers: rows(r.header !== undefined ? r.header : r.headers, "header"),
      body: toBody(r.body),
      auth: toAuth(r.auth),
    };
  }

  function sendRequest(r, cb) {
    return settle(cb, function () {
      return makeResponse(JSON.parse(host.sendRequest(JSON.stringify(toRequest(r)))));
    });
  }

  // ---- pm.cookies ----

  function toCookie(c) {
    var out = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      hostOnly: c.hostOnly,
      secure: c.secure,
      httpOnly: c.httpOnly,
      session: !c.expiresAt,
    };
    if (c.expiresAt) out.expires = new Date(c.expiresAt).toISOString();
    return out;
  }

  function cookiesFor(u) {
    return JSON.parse(host.cookieList(str(u))).map(toCookie);
  }

  function fromCookie(name, value) {
    var c = name !== null && typeof name === "object" ? name : { name: name, value: value };
    var expiresAt = 0;
    if (c.maxAge !== undefined && c.maxAge !== null) {
      expiresAt = Date.now() + Number(c.maxAge) * 1000;
    } else if (c.expires !== undefined && c.expires !== null) {
      expiresAt = new Date(c.expires).getTime();
    }
    if (isNaN(expiresAt)) fail("The cookie's expiry isn't a valid date");
    return {
      name: str(c.name).trim(),
      value: str(c.value),
      domain: str(c.domain),
      path: str(c.path),
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: "",
      expiresAt: expiresAt,
    };
  }

  function needURL(u, what) {
    if (typeof u !== "string" || u.trim() === "") fail(what + " needs a URL");
    return u;
  }

  var jar = {
    get: function (u, name, cb) {
      return settle(cb, function () {
        var hit;
        cookiesFor(needURL(u, "jar.get")).forEach(function (c) {
          if (hit === undefined && c.name === str(name)) hit = c.value;
        });
        return hit;
      });
    },
    getAll: function (u, cb) {
      return settle(cb, function () {
        return cookiesFor(needURL(u, "jar.getAll"));
      });
    },
    set: function (u, name, value, cb) {
      if (typeof value === "function" && cb === undefined) {
        cb = value;
        value = undefined;
      }
      return settle(cb, function () {
        return toCookie(JSON.parse(host.cookieSet(needURL(u, "jar.set"), JSON.stringify(fromCookie(name, value)))));
      });
    },
    unset: function (u, name, cb) {
      return settle(cb, function () {
        host.cookieDelete(needURL(u, "jar.unset"), str(name));
      });
    },
    clear: function (u, cb) {
      return settle(cb, function () {
        host.cookieDelete(needURL(u, "jar.clear"), "");
      });
    },
  };

  // pm.cookies: the cookies a request to the current URL sends (in a test
  // script, including those its response set).
  function current() {
    return cookiesFor(req.url);
  }
  var cookies = {
    get: function (name) {
      var hit;
      current().forEach(function (c) {
        if (hit === undefined && c.name === str(name)) hit = c.value;
      });
      return hit;
    },
    has: function (name, value) {
      return current().some(function (c) {
        return c.name === str(name) && (value === undefined || c.value === str(value));
      });
    },
    all: current,
    count: function () {
      return current().length;
    },
    each: function (fn) {
      current().forEach(function (c) {
        fn(c);
      });
    },
    toObject: function () {
      var o = {};
      current()
        .slice()
        .reverse()
        .forEach(function (c) {
          o[c.name] = c.value;
        });
      return o;
    },
    jar: function () {
      return jar;
    },
  };

  // ---- pm ----

  var data = input.iterationData || {};
  var execution = {
    setNextRequest: function (name) {
      state.nextRequestSet = true;
      state.nextRequest = name === null || name === undefined ? null : str(name);
    },
    skipRequest: function () {
      state.skip = true;
    },
  };

  var pm = {
    environment: environment,
    collectionVariables: scope("collection", "pm.collectionVariables"),
    globals: scope("global", "pm.globals"),
    variables: scope("", "pm.variables"),
    request: request,
    info: {
      eventName: input.event,
      requestName: req.name,
      requestId: req.id,
      iteration: input.iteration,
      iterationCount: input.iterationCount,
    },
    iterationData: {
      get: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
      },
      has: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key);
      },
      toObject: function () {
        return Object.assign({}, data);
      },
      toJSON: function () {
        return Object.assign({}, data);
      },
    },
    execution: execution,
    test: test,
    expect: expect,
    sendRequest: sendRequest,
    cookies: cookies,
  };
  if (input.response) pm.response = makeResponse(input.response);

  // ---- globals ----

  function log(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(typeof a === "string" ? a : lib.inspect(a, { json: true, depth: 5 }));
      }
      host.log(level, parts.join(" "));
    };
  }

  function unavailable(name, why) {
    return function () {
      fail(name + " isn't available in Pakpos scripts: " + why);
    };
  }

  var timers = "scripts run synchronously and stop when they end";
  g.pm = pm;
  g.postman = { setNextRequest: execution.setNextRequest };
  g.console = { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };
  g.setTimeout = unavailable("setTimeout", timers);
  g.setInterval = unavailable("setInterval", timers);
  g.setImmediate = unavailable("setImmediate", timers);
  g.clearTimeout = unavailable("clearTimeout", timers);
  g.clearInterval = unavailable("clearInterval", timers);
  g.require = unavailable("require", "there are no modules to load");
  g.fetch = unavailable("fetch", "use pm.sendRequest");
  g.btoa = function (s) {
    return host.btoa(str(s));
  };
  g.atob = function (s) {
    return host.atob(str(s));
  };

  return {
    // drain runs the callbacks waiting so far and returns how many ran.
    drain: function () {
      var run = pending;
      pending = [];
      run.forEach(function (fn) {
        fn();
      });
      return run.length;
    },
    finish: function () {
      return JSON.stringify(state);
    },
  };
});
