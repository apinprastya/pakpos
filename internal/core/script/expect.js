// Pakpos expect: the subset of chai's BDD API that pm.expect and
// pm.response.to offer. Messages follow chai's wording ("expected 404 to
// equal 200") so Postman users recognise them.
//
// The program's value is a function returning {expect, inspect, deepEqual,
// AssertionError}; prelude.js wires it into pm.
(function () {
  "use strict";

  class AssertionError extends Error {
    constructor(message) {
      super(message);
      this.name = "AssertionError";
    }
  }

  var TRUNCATE = 40;
  var toStr = Object.prototype.toString;

  function type(v) {
    if (v === null) return "null";
    var t = typeof v;
    if (t !== "object") return t;
    return toStr.call(v).slice(8, -1).toLowerCase();
  }

  // inspect formats a value for messages. opts.json gives the console's
  // JSON-ish form ({"a": 1}); otherwise chai's ({ a: 1 }), with long
  // objects shortened as chai does.
  function inspect(v, opts, depth, seen) {
    opts = opts || {};
    depth = depth || 0;
    seen = seen || [];
    var max = opts.depth === undefined ? 2 : opts.depth;
    var q = function (s) {
      return opts.json ? JSON.stringify(s) : "'" + s + "'";
    };
    switch (type(v)) {
      case "string":
        return q(v);
      case "number":
        return Object.is(v, -0) ? "-0" : String(v);
      case "bigint":
        return String(v) + "n";
      case "boolean":
      case "undefined":
      case "null":
        return String(v);
      case "symbol":
        return v.toString();
      case "function":
        return "[Function" + (v.name ? ": " + v.name : "") + "]";
      case "regexp":
        return String(v);
      case "date":
        return isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
      case "error":
        return v.name + ": " + v.message;
    }
    if (seen.indexOf(v) >= 0) return "[Circular]";
    var t = type(v);
    if (t === "array" || t === "arguments") {
      if (depth > max) return "[Array]";
      if (v.length === 0) return "[]";
      seen.push(v);
      var items = [];
      for (var i = 0; i < v.length; i++) items.push(inspect(v[i], opts, depth + 1, seen));
      seen.pop();
      return opts.json ? "[" + items.join(", ") + "]" : "[ " + items.join(", ") + " ]";
    }
    if (t === "map" || t === "set") {
      var name = t === "map" ? "Map" : "Set";
      if (depth > max) return "[" + name + "]";
      seen.push(v);
      var parts = [];
      v.forEach(function (val, key) {
        parts.push(t === "map" ? inspect(key, opts, depth + 1, seen) + " => " + inspect(val, opts, depth + 1, seen) : inspect(val, opts, depth + 1, seen));
      });
      seen.pop();
      return name + "(" + v.size + ") {" + (parts.length ? " " + parts.join(", ") + " " : "") + "}";
    }
    if (depth > max) return "[Object]";
    var keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    seen.push(v);
    var props = keys.map(function (k) {
      var key = opts.json ? JSON.stringify(k) : /^[A-Za-z_$][\w$]*$/.test(k) ? k : "'" + k + "'";
      return key + ": " + inspect(v[k], opts, depth + 1, seen);
    });
    seen.pop();
    return opts.json ? "{" + props.join(", ") + "}" : "{ " + props.join(", ") + " }";
  }

  // show is chai's objDisplay: long arrays and objects are summarised.
  function show(v) {
    var s = inspect(v);
    if (s.length < TRUNCATE) return s;
    var t = type(v);
    if (t === "function") return v.name ? "[Function: " + v.name + "]" : "[Function]";
    if (t === "array") return "[ Array(" + v.length + ") ]";
    if (t === "object") {
      var keys = Object.keys(v);
      var list = keys.length > 2 ? keys.slice(0, 2).join(", ") + ", ..." : keys.join(", ");
      return "{ Object (" + list + ") }";
    }
    return s;
  }

  function deepEqual(a, b, memo) {
    if (a === b) return a !== 0 || 1 / a === 1 / b;
    if (a !== a && b !== b) return true; // NaN
    var ta = type(a);
    if (ta !== type(b)) return false;
    if (ta === "date") return a.getTime() === b.getTime();
    if (ta === "regexp") return String(a) === String(b);
    if (typeof a !== "object" || a === null || b === null) return false;
    memo = memo || [];
    for (var i = 0; i < memo.length; i++) {
      if (memo[i][0] === a && memo[i][1] === b) return true;
    }
    memo.push([a, b]);
    if (ta === "map" || ta === "set") {
      if (a.size !== b.size) return false;
      var ea = Array.from(a.entries()), eb = Array.from(b.entries());
      return ea.every(function (x) {
        return eb.some(function (y) {
          return deepEqual(x, y, memo);
        });
      });
    }
    if (ta === "array" || ta === "arguments") {
      if (a.length !== b.length) return false;
      for (var j = 0; j < a.length; j++) if (!deepEqual(a[j], b[j], memo)) return false;
      return true;
    }
    var ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (var k = 0; k < ka.length; k++) {
      if (ka[k] !== kb[k] || !deepEqual(a[ka[k]], b[kb[k]], memo)) return false;
    }
    return true;
  }

  function article(t) {
    return /^[aeiou]/i.test(t) ? "an " + t : "a " + t;
  }

  function Assertion(obj, msg, flags) {
    this._obj = obj;
    this._msg = msg;
    this._flags = flags || {};
  }

  var P = Assertion.prototype;

  P.assert = function (ok, msg, negMsg) {
    var pass = this._flags.negate ? !ok : !!ok;
    if (!pass) {
      var text = this._flags.negate ? negMsg : msg;
      throw new AssertionError(this._msg ? this._msg + ": " + text : text);
    }
    return this;
  };

  function chain(name, fn) {
    Object.defineProperty(P, name, { get: fn, configurable: true });
  }

  ["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "does", "but", "also", "still"].forEach(function (w) {
    chain(w, function () {
      return this;
    });
  });
  chain("not", function () {
    this._flags.negate = !this._flags.negate;
    return this;
  });
  chain("deep", function () {
    this._flags.deep = true;
    return this;
  });
  chain("own", function () {
    this._flags.own = true;
    return this;
  });
  chain("any", function () {
    this._flags.any = true;
    this._flags.all = false;
    return this;
  });
  chain("all", function () {
    this._flags.all = true;
    this._flags.any = false;
    return this;
  });

  // chainable defines a word that works both as a method and as a chain
  // property (include, a, length): the getter returns a function whose
  // prototype is the assertion, so further words still reach it.
  function chainable(names, method, property) {
    names.forEach(function (name) {
      chain(name, function () {
        var self = this;
        if (property) property.call(self);
        var fn = function () {
          return method.apply(self, arguments);
        };
        Object.setPrototypeOf(fn, self);
        return fn;
      });
    });
  }

  function method(names, fn) {
    names.forEach(function (n) {
      P[n] = fn;
    });
  }

  function isResponse(v) {
    return v !== null && typeof v === "object" && v.__pmResponse === true;
  }

  function codeIs(self, ok, want) {
    var code = self._obj.code;
    return self.assert(ok(code), "expected response code to be " + want + " but found " + code, "expected response code to not be " + want + " but found " + code);
  }

  // ---- values ----

  method(["equal", "equals", "eq"], function (exp) {
    if (this._flags.deep) return this.eql(exp);
    var act = this._obj;
    return this.assert(act === exp, "expected " + show(act) + " to equal " + show(exp), "expected " + show(act) + " to not equal " + show(exp));
  });

  method(["eql", "eqls"], function (exp) {
    var act = this._obj;
    return this.assert(deepEqual(act, exp), "expected " + show(act) + " to deeply equal " + show(exp), "expected " + show(act) + " to not deeply equal " + show(exp));
  });

  chainable(["a", "an"], function (t) {
    var want = String(t).toLowerCase();
    var act = this._obj;
    return this.assert(type(act) === want, "expected " + show(act) + " to be " + article(want), "expected " + show(act) + " not to be " + article(want));
  });

  function includes(self, val) {
    var obj = self._obj, deep = self._flags.deep;
    switch (type(obj)) {
      case "string":
        return obj.indexOf(val) !== -1;
      case "array":
        return obj.some(function (x) {
          return deep ? deepEqual(x, val) : x === val;
        });
      case "map":
      case "set":
        var found = false;
        obj.forEach(function (x) {
          if (deep ? deepEqual(x, val) : x === val) found = true;
        });
        return found;
      case "object":
        if (val !== null && typeof val === "object") {
          return Object.keys(val).every(function (k) {
            return k in obj && (deep ? deepEqual(obj[k], val[k]) : obj[k] === val[k]);
          });
        }
        return false;
      default:
        throw new TypeError(show(obj) + " doesn't support .include; use a string, an array or an object");
    }
  }

  chainable(
    ["include", "includes", "contain", "contains"],
    function (val) {
      var act = this._obj;
      var deep = this._flags.deep ? "deep " : "";
      return this.assert(includes(this, val), "expected " + show(act) + " to " + deep + "include " + show(val), "expected " + show(act) + " to not " + deep + "include " + show(val));
    },
    function () {
      this._flags.contains = true;
    },
  );

  method(["string"], function (s) {
    var act = this._obj;
    return this.assert(typeof act === "string" && act.indexOf(s) !== -1, "expected " + show(act) + " to contain " + show(s), "expected " + show(act) + " to not contain " + show(s));
  });

  function hasProp(self, name) {
    var obj = self._obj;
    if (obj === null || obj === undefined) return false;
    if (self._flags.own) return Object.prototype.hasOwnProperty.call(obj, name);
    return name in Object(obj);
  }

  method(["property"], function (name) {
    var act = this._obj;
    var own = this._flags.own ? "own " : "";
    var has = hasProp(this, name);
    if (arguments.length > 1) {
      var exp = arguments[1];
      var val = has ? act[name] : undefined;
      var same = this._flags.deep ? deepEqual(val, exp) : val === exp;
      this.assert(
        has && same,
        "expected " + show(act) + " to have " + own + "property " + inspect(name) + " of " + show(exp) + (has ? ", but got " + show(val) : ""),
        "expected " + show(act) + " to not have " + own + "property " + inspect(name) + " of " + show(exp),
      );
    } else {
      this.assert(has, "expected " + show(act) + " to have " + own + "property " + inspect(name), "expected " + show(act) + " to not have " + own + "property " + inspect(name));
    }
    if (has) this._obj = act[name];
    return this;
  });

  method(["ownProperty", "haveOwnProperty"], function () {
    this._flags.own = true;
    return this.property.apply(this, arguments);
  });

  function lengthOf(v) {
    var t = type(v);
    if (t === "map" || t === "set") return v.size;
    if (v === null || v === undefined || v.length === undefined) {
      throw new TypeError("expected " + show(v) + " to have a length");
    }
    return v.length;
  }

  chainable(
    ["length", "lengthOf"],
    function (n) {
      var len = lengthOf(this._obj);
      return this.assert(len === n, "expected " + show(this._obj) + " to have a length of " + n + " but got " + len, "expected " + show(this._obj) + " to not have a length of " + n);
    },
    function () {
      this._flags.doLength = true;
    },
  );

  // compare implements above/below/least/most: on the value or, after
  // .length, on its length.
  function compare(self, n, test, words) {
    var act = self._obj;
    if (self._flags.doLength) {
      var len = lengthOf(act);
      return self.assert(test(len), "expected " + show(act) + " to have a length " + words + " " + n + " but got " + len, "expected " + show(act) + " to not have a length " + words + " " + n);
    }
    if (typeof act !== "number" && type(act) !== "date") {
      throw new TypeError("expected " + show(act) + " to be a number or a date");
    }
    return self.assert(test(act), "expected " + show(act) + " to be " + words + " " + show(n), "expected " + show(act) + " to be not " + words + " " + show(n));
  }

  method(["above", "gt", "greaterThan"], function (n) {
    return compare(this, n, function (v) {
      return v > n;
    }, "above");
  });
  method(["below", "lt", "lessThan"], function (n) {
    return compare(this, n, function (v) {
      return v < n;
    }, "below");
  });
  method(["least", "gte", "greaterThanOrEqual"], function (n) {
    return compare(this, n, function (v) {
      return v >= n;
    }, "at least");
  });
  method(["most", "lte", "lessThanOrEqual"], function (n) {
    return compare(this, n, function (v) {
      return v <= n;
    }, "at most");
  });
  method(["within"], function (lo, hi) {
    var act = this._obj;
    var range = lo + ".." + hi;
    if (this._flags.doLength) {
      var len = lengthOf(act);
      return this.assert(len >= lo && len <= hi, "expected " + show(act) + " to have a length within " + range, "expected " + show(act) + " to not have a length within " + range);
    }
    return this.assert(act >= lo && act <= hi, "expected " + show(act) + " to be within " + range, "expected " + show(act) + " to not be within " + range);
  });
  method(["closeTo", "approximately"], function (exp, delta) {
    var act = this._obj;
    return this.assert(Math.abs(act - exp) <= delta, "expected " + show(act) + " to be close to " + exp + " +/- " + delta, "expected " + show(act) + " not to be close to " + exp + " +/- " + delta);
  });

  chain("ok", function () {
    if (isResponse(this._obj)) {
      return codeIs(this, function (c) {
        return c === 200;
      }, "200");
    }
    return this.assert(this._obj, "expected " + show(this._obj) + " to be truthy", "expected " + show(this._obj) + " to be falsy");
  });

  [
    ["true", true],
    ["false", false],
    ["null", null],
    ["undefined", undefined],
  ].forEach(function (pair) {
    chain(pair[0], function () {
      return this.assert(this._obj === pair[1], "expected " + show(this._obj) + " to be " + pair[0], "expected " + show(this._obj) + " to not be " + pair[0]);
    });
  });

  chain("NaN", function () {
    return this.assert(Number.isNaN(this._obj), "expected " + show(this._obj) + " to be NaN", "expected " + show(this._obj) + " not to be NaN");
  });

  chain("exist", function () {
    var v = this._obj;
    return this.assert(v !== null && v !== undefined, "expected " + show(v) + " to exist", "expected " + show(v) + " to not exist");
  });

  chain("empty", function () {
    var v = this._obj, n;
    switch (type(v)) {
      case "string":
      case "array":
        n = v.length;
        break;
      case "map":
      case "set":
        n = v.size;
        break;
      case "object":
        n = Object.keys(v).length;
        break;
      default:
        throw new TypeError(".empty was passed " + show(v) + "; use a string, an array or an object");
    }
    return this.assert(n === 0, "expected " + show(v) + " to be empty", "expected " + show(v) + " not to be empty");
  });

  method(["match", "matches"], function (re) {
    var act = this._obj;
    return this.assert(re.exec(act), "expected " + show(act) + " to match " + re, "expected " + show(act) + " not to match " + re);
  });

  method(["oneOf"], function (list) {
    var act = this._obj, deep = this._flags.deep;
    var ok = list.some(function (x) {
      return deep ? deepEqual(x, act) : x === act;
    });
    return this.assert(ok, "expected " + show(act) + " to be one of " + inspect(list), "expected " + show(act) + " to not be one of " + inspect(list));
  });

  method(["keys", "key"], function () {
    var obj = this._obj;
    var want = arguments[0];
    if (type(want) === "array") want = want.slice();
    else if (type(want) === "object") want = Object.keys(want);
    else want = Array.prototype.slice.call(arguments);
    var have = type(obj) === "map" || type(obj) === "set" ? Array.from(obj.keys()) : Object.keys(Object(obj));
    var present = want.filter(function (k) {
      return have.indexOf(k) !== -1;
    });
    var ok, words;
    var list = want.map(function (k) {
      return inspect(k);
    }).join(", ");
    if (this._flags.any) {
      ok = present.length > 0;
      words = "have any of keys ";
    } else if (this._flags.contains) {
      ok = present.length === want.length;
      words = "contain keys ";
    } else {
      ok = present.length === want.length && have.length === want.length;
      words = "have keys ";
    }
    return this.assert(ok, "expected " + show(obj) + " to " + words + list, "expected " + show(obj) + " to not " + words + list);
  });

  method(["members"], function (list) {
    var act = this._obj, deep = this._flags.deep;
    var has = function (arr, x) {
      return arr.some(function (y) {
        return deep ? deepEqual(x, y) : x === y;
      });
    };
    var subset = list.every(function (x) {
      return has(act, x);
    });
    var ok = this._flags.contains ? subset : subset && act.length === list.length && act.every(function (x) {
      return has(list, x);
    });
    var words = this._flags.contains ? "be a superset of " : "have the same members as ";
    return this.assert(ok, "expected " + show(act) + " to " + words + show(list), "expected " + show(act) + " to not " + words + show(list));
  });

  method(["instanceOf", "instanceof"], function (ctor) {
    var act = this._obj;
    var name = ctor && ctor.name ? ctor.name : String(ctor);
    return this.assert(act instanceof ctor, "expected " + show(act) + " to be an instance of " + name, "expected " + show(act) + " to not be an instance of " + name);
  });

  method(["satisfy", "satisfies"], function (fn) {
    var act = this._obj;
    return this.assert(fn(act), "expected " + show(act) + " to satisfy " + show(fn), "expected " + show(act) + " to not satisfy " + show(fn));
  });

  method(["throw", "throws", "Throw"], function (want) {
    var fn = this._obj, thrown = false, err;
    try {
      fn();
    } catch (e) {
      thrown = true;
      err = e;
    }
    var ok = thrown;
    var what = "";
    if (thrown && want !== undefined) {
      var msg = err && err.message !== undefined ? err.message : String(err);
      if (type(want) === "regexp") {
        ok = want.test(msg);
        what = " matching " + want;
      } else if (typeof want === "string") {
        ok = msg.indexOf(want) !== -1;
        what = " including " + inspect(want);
      } else if (typeof want === "function") {
        ok = err instanceof want;
        what = " " + (want.name || "error");
      }
    }
    return this.assert(ok, "expected " + show(fn) + " to throw an error" + what, "expected " + show(fn) + " to not throw an error" + what);
  });

  method(["fail"], function (message) {
    throw new AssertionError(message || "assert.fail()");
  });

  // ---- response (pm.response.to) ----

  function needResponse(self, name) {
    if (!isResponse(self._obj)) throw new TypeError("." + name + " can only be used with pm.response");
  }

  function headerOf(res, name) {
    return res.headers.get(name);
  }

  method(["status"], function (want) {
    needResponse(this, "status");
    var res = this._obj;
    if (typeof want === "number") {
      return this.assert(res.code === want, "expected response to have status code " + want + " but got " + res.code, "expected response to not have status code " + want);
    }
    return this.assert(res.status === want, "expected response to have status reason " + inspect(want) + " but got " + inspect(res.status), "expected response to not have status reason " + inspect(want));
  });

  method(["header"], function (name, value) {
    needResponse(this, "header");
    var got = headerOf(this._obj, name);
    if (arguments.length < 2) {
      return this.assert(got !== undefined, "expected response to have header with key " + inspect(name), "expected response to not have header with key " + inspect(name));
    }
    return this.assert(
      got === value,
      "expected " + inspect(name) + " response header to be " + inspect(value) + " but got " + inspect(got),
      "expected " + inspect(name) + " response header to not be " + inspect(value),
    );
  });

  function parseBody(res) {
    try {
      return { ok: true, value: JSON.parse(res.text()) };
    } catch (e) {
      return { ok: false };
    }
  }

  // path reads a lodash-style path ("a.b[0].c") from a value.
  function getPath(obj, path) {
    var parts = String(path).replace(/\[(\w+)\]/g, ".$1").split(".").filter(function (p) {
      return p !== "";
    });
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== "object" || !(parts[i] in cur)) return { found: false };
      cur = cur[parts[i]];
    }
    return { found: true, value: cur };
  }

  method(["jsonBody"], function (path, value) {
    needResponse(this, "jsonBody");
    var body = parseBody(this._obj);
    if (arguments.length === 0) {
      return this.assert(body.ok, "expected response body to be a valid json", "expected response body to not be a valid json");
    }
    if (!body.ok) throw new AssertionError("expected response body to be a valid json");
    var at = getPath(body.value, path);
    if (arguments.length === 1) {
      return this.assert(at.found, "expected response body json to have path " + inspect(path), "expected response body json to not have path " + inspect(path));
    }
    return this.assert(
      at.found && deepEqual(at.value, value),
      "expected response body json at " + inspect(path) + " to deeply equal " + show(value) + (at.found ? " but got " + show(at.value) : ""),
      "expected response body json at " + inspect(path) + " to not deeply equal " + show(value),
    );
  });

  method(["body"], function (want) {
    needResponse(this, "body");
    var text = this._obj.text();
    if (arguments.length === 0) {
      return this.assert(text.length > 0, "expected response to have content in body", "expected response to not have content in body");
    }
    if (type(want) === "regexp") {
      return this.assert(want.test(text), "expected response body text to match " + want, "expected response body text to not match " + want);
    }
    if (typeof want === "string") {
      return this.assert(text === want, "expected response body to equal " + show(want) + " but got " + show(text), "expected response body to not equal " + show(want));
    }
    var body = parseBody(this._obj);
    return this.assert(body.ok && deepEqual(body.value, want), "expected response body json to deeply equal " + show(want), "expected response body json to not deeply equal " + show(want));
  });

  chain("success", function () {
    needResponse(this, "success");
    return codeIs(this, function (c) {
      return c >= 200 && c < 300;
    }, "2XX");
  });
  chain("error", function () {
    needResponse(this, "error");
    return codeIs(this, function (c) {
      return c >= 400 && c < 600;
    }, "4XX or 5XX");
  });
  chain("clientError", function () {
    needResponse(this, "clientError");
    return codeIs(this, function (c) {
      return c >= 400 && c < 500;
    }, "4XX");
  });
  chain("serverError", function () {
    needResponse(this, "serverError");
    return codeIs(this, function (c) {
      return c >= 500 && c < 600;
    }, "5XX");
  });
  chain("json", function () {
    needResponse(this, "json");
    return this.assert(parseBody(this._obj).ok, "expected response body to be a valid json", "expected response body to not be a valid json");
  });

  function expect(obj, msg) {
    return new Assertion(obj, msg);
  }
  expect.fail = function (message) {
    throw new AssertionError(message || "expect.fail()");
  };

  return { expect: expect, inspect: inspect, deepEqual: deepEqual, AssertionError: AssertionError };
})();
