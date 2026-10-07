window.__ModuleLoader__.load({
  id: "dsh-oh-my-codex",
  factory: (require) => {
    var module = { exports: {} };
    // 设置 → Codex 引擎:oh-my-codex 的登录、额度与诊断(settings.section slot,照 dsh-network-proxy)。
    var API = "/dsh-oh-my-codex/api";

    function el(tag, css, text) {
      var e = document.createElement(tag);
      if (css) e.style.cssText = css;
      if (text != null) e.textContent = text;
      return e;
    }
    function api(method, route) {
      return fetch(API + route, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      }).then(function (r) { return r.json(); });
    }
    var C = {
      card: "background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;padding:12px 16px;margin:10px 0;",
      title: "font-size:13.5px;font-weight:600;display:block;margin-bottom:8px;",
      sub: "font-size:12px;opacity:.6;",
      btn: "border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:transparent;color:inherit;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;margin-left:6px;",
      primary: "background:var(--dsw-alias-accent,#2563eb);color:#fff;border-color:transparent;",
      code: "font-family:ui-monospace,monospace;font-size:22px;font-weight:700;letter-spacing:2px;padding:4px 10px;border-radius:8px;background:var(--dsw-alias-bg-base,#f3f4f6);",
    };
    var STATE = {
      connected: ["🟢", "已连接"],
      starting: ["🟡", "检测中"],
      "not-started": ["⚪", "未检测"],
      "connection-failed": ["🔴", "连接失败"],
      unavailable: ["🔴", "不可用"],
    };
    function toast(root, msg, bad) {
      var t = el("div", "position:absolute;top:10px;right:16px;z-index:99;max-width:420px;padding:9px 14px;border-radius:9px;font-size:12.5px;color:#fff;white-space:pre-wrap;background:" + (bad ? "#b23c2e" : "#0e8f83"), msg);
      root.appendChild(t); setTimeout(function () { t.remove(); }, bad ? 7000 : 3000);
    }
    function busy(btn, label, p) {
      btn.disabled = true; var old = btn.textContent; btn.textContent = label;
      return p.finally(function () { btn.disabled = false; btn.textContent = old; });
    }
    function time(ms) {
      if (!ms) return "—";
      var d = new Date(ms < 1e12 ? ms * 1000 : ms);
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    function windowLabel(mins) {
      if (!mins) return "额度";
      if (mins % 10080 === 0) return "每周额度";
      if (mins % 1440 === 0) return (mins / 1440) + " 天额度";
      if (mins % 60 === 0) return (mins / 60) + " 小时额度";
      return mins + " 分钟额度";
    }
    function quota(w) {
      var left = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
      var color = left > 30 ? "#0e8f83" : left > 10 ? "#c97a13" : "#ef4444";
      var box = el("div", "flex:1;min-width:200px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-base,#f9fafb);");
      var top = el("div", "display:flex;justify-content:space-between;font-size:12.5px;");
      top.appendChild(el("span", "", windowLabel(w.windowDurationMins)));
      top.appendChild(el("b", "", "剩余 " + left + "%"));
      box.appendChild(top);
      var bar = el("div", "height:6px;border-radius:3px;background:var(--dsw-alias-border-l1,#e5e7eb);margin:8px 0 6px;");
      bar.appendChild(el("div", "height:6px;border-radius:3px;width:" + left + "%;background:" + color + ";"));
      box.appendChild(bar);
      box.appendChild(el("div", C.sub, "重置于 " + time(w.resetsAt)));
      return box;
    }

    function render(body, root) {
      if (root.__erPoll) { clearTimeout(root.__erPoll); root.__erPoll = 0; }
      // Stop polling once the settings panel is closed.
      if (root.__erRendered && !root.isConnected) return;
      root.__erRendered = 1;
      api("GET", "/status").then(function (s) {
        body.textContent = "";
        if (!s.ok) { body.textContent = "加载失败:" + (s.error || ""); return; }
        var rerender = function () { render(body, root); };
        var p = s.preflight || {}, st = s.status || {}, login = s.login;
        var signedIn = p.signedIn === true && st.state === "connected";

        // 引擎状态
        var sc = el("div", C.card);
        var head = el("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;");
        var label = STATE[st.state] || ["⚪", st.state || "未知"];
        head.appendChild(el("b", "font-size:13.5px;flex:1;", label[0] + " Codex 引擎:" + label[1]));
        var again = el("button", C.btn, "重新检测");
        again.onclick = function () {
          busy(again, "检测中…", api("POST", "/refresh").then(function (r) {
            if (!r.ok) toast(root, r.error, true); rerender();
          }));
        };
        head.appendChild(again);
        if (p.signedIn) {
          var out = el("button", C.btn, "退出登录");
          out.onclick = function () {
            if (!window.confirm("退出后 Codex 引擎和 Codex 子代理都将不可用,直到重新登录。确定退出?")) return;
            busy(out, "退出中…", api("POST", "/logout").then(function (r) {
              toast(root, r.ok ? "已退出登录" : r.error, !r.ok); rerender();
            }));
          };
          head.appendChild(out);
        }
        sc.appendChild(head);
        var facts = [];
        if (p.email) facts.push(p.email);
        if (p.planType) facts.push("套餐 " + p.planType);
        if (p.userAgent) facts.push((p.userAgent.match(/\/([0-9][^ ]*)/) || [])[1] ? "Codex " + p.userAgent.match(/\/([0-9][^ ]*)/)[1] : p.userAgent);
        if (facts.length) sc.appendChild(el("div", C.sub + "margin-top:6px;", facts.join(" · ")));
        if (st.code) {
          sc.appendChild(el("div", "font-size:12px;color:" + (st.state === "connected" ? "#c97a13" : "#ef4444") + ";margin-top:6px;", st.code + (st.message ? ":" + st.message : "")));
          if (st.action) sc.appendChild(el("div", C.sub + "margin-top:2px;", "下一步:" + st.action));
        }
        body.appendChild(sc);

        // 登录
        if (!signedIn || (login && login.state === "pending")) {
          var lc = el("div", C.card);
          lc.appendChild(el("span", C.title, "登录 Codex(ChatGPT 账号)"));
          if (login && login.state === "pending") {
            lc.appendChild(el("div", "font-size:12.5px;margin-bottom:8px;", "在登录页输入下面的设备代码,完成后此页自动刷新:"));
            var codeRow = el("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;");
            codeRow.appendChild(el("span", C.code, login.userCode));
            var copy = el("button", C.btn, "复制代码");
            copy.onclick = function () { navigator.clipboard && navigator.clipboard.writeText(login.userCode).then(function () { toast(root, "已复制"); }); };
            codeRow.appendChild(copy);
            var open = el("a", C.btn + C.primary + "text-decoration:none;", "打开登录页");
            open.href = login.verificationUrl; open.target = "_blank"; open.rel = "noopener noreferrer";
            codeRow.appendChild(open);
            var cancel = el("button", C.btn, "取消");
            cancel.onclick = function () { busy(cancel, "取消中…", api("POST", "/login/cancel").then(rerender)); };
            codeRow.appendChild(cancel);
            lc.appendChild(codeRow);
            lc.appendChild(el("div", C.sub + "margin-top:8px;", "代码 " + time(login.expiresAt) + " 前有效。仅在你自己发起登录时输入;不要把代码发给他人。"));
            root.__erPoll = setTimeout(rerender, 3000);
          } else {
            if (login && login.state === "failed") lc.appendChild(el("div", "font-size:12px;color:#ef4444;margin-bottom:6px;", "上次登录失败:" + (login.error || "未知错误") + "。网络不稳时重试即可。"));
            if (login && login.state === "succeeded" && !signedIn) lc.appendChild(el("div", C.sub + "margin-bottom:6px;", "已登录,正在重新检测…"));
            lc.appendChild(el("div", C.sub + "margin-bottom:8px;", "用设备代码登录:凭据由 Codex 写入本实例的 CODEX_HOME,不经过浏览器。Codex 引擎与 Codex 子代理共用这份登录;与「Codex 订阅」插件的登录相互独立。"));
            var start = el("button", C.btn + C.primary + "margin-left:0;", "设备代码登录");
            start.onclick = function () {
              busy(start, "获取代码…", api("POST", "/login/start").then(function (r) {
                if (!r.ok) toast(root, r.error, true); rerender();
              }));
            };
            lc.appendChild(start);
            if (login && login.state === "succeeded") root.__erPoll = setTimeout(rerender, 3000);
          }
          body.appendChild(lc);
        }

        // 额度(turn 内实时更新优先,启动检测兜底)
        var q = s.quota;
        var rl = (q && (q.primary || q.secondary)) ? q : p.rateLimits;
        if (signedIn && rl && (rl.primary || rl.secondary)) {
          var qc = el("div", C.card);
          qc.appendChild(el("span", C.title, "订阅额度"));
          var qr = el("div", "display:flex;gap:10px;flex-wrap:wrap;");
          if (rl.primary) qr.appendChild(quota(rl.primary));
          if (rl.secondary) qr.appendChild(quota(rl.secondary));
          qc.appendChild(qr);
          var stale = q && q.at && Date.now() - q.at > 600000;
          qc.appendChild(el("div", C.sub + "margin-top:6px;",
            "更新于 " + time(q ? q.at : p.at) + (q && q.source === "turn" ? "(来自最近一轮)" : "(来自启动检测)")
            + (stale ? "(数据可能已过期)" : "") + ";与 Codex 子代理及同账号其他客户端共用。"));
          body.appendChild(qc);
        }

        // 模型
        if (p.configured) {
          var mc = el("div", C.card);
          mc.appendChild(el("span", C.title, "模型"));
          mc.appendChild(el("div", "font-size:12.5px;", "已启用:" + p.configured.join("、")));
          if (p.missing && p.missing.length) mc.appendChild(el("div", "font-size:12px;color:#c97a13;margin-top:4px;", "账号未提供:" + p.missing.join("、")));
          if (p.models) mc.appendChild(el("div", C.sub + "margin-top:4px;", "账号可用:" + p.models.join("、")));
          body.appendChild(mc);
        }

        // 诊断
        var recent = s.recent || [];
        var dc = el("details", C.card);
        dc.appendChild(el("summary", "font-size:13px;font-weight:600;cursor:pointer;", "最近诊断(" + recent.length + ")"));
        recent.slice().reverse().forEach(function (e) {
          var line = el("div", "font-size:12px;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1,#eee);");
          line.appendChild(el("span", "font-family:ui-monospace,monospace;font-weight:600;", e.code));
          line.appendChild(el("span", C.sub + "margin-left:8px;", time(e.at) + (e.method ? " · " + e.method : "") + (e.phase ? " · " + e.phase : "")));
          if (e.message) line.appendChild(el("div", "margin-top:2px;white-space:pre-wrap;word-break:break-all;", e.message));
          if (e.stderr) line.appendChild(el("div", C.sub + "margin-top:2px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,monospace;", e.stderr.slice(-600)));
          dc.appendChild(line);
        });
        if (!recent.length) dc.appendChild(el("div", C.sub + "padding:4px 0;", "暂无"));
        body.appendChild(dc);
      }).catch(function (e) {
        body.textContent = "加载失败:" + e;
      });
    }

    function pillText(w) {
      if (!w) return "";
      var left = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
      return left + "%";
    }
    function pillColor(w) {
      if (!w) return "#6b7280";
      var left = Math.round(100 - w.usedPercent);
      return left > 30 ? "#0e8f83" : left > 10 ? "#c97a13" : "#ef4444";
    }
    // Compact composer pill (plain-DOM inside a React shell): shows the
    // subscription usage only while the session runs on this engine.
    function mountPill(elm, sessionId, providersRef, ctx) {
      var timer = 0, stop = false, visible = false;
      var unsubscribe = function () {};
      function render(quotaData) {
        if (stop) return;
        elm.textContent = "";
        var q = quotaData && quotaData.quota;
        var st = (quotaData && quotaData.status) || {};
        if (!q || st.state !== "connected" || !(q.primary || q.secondary)) return;
        var short = q.primary || q.secondary;
        var long = q.primary ? q.secondary : null;
        var exhausted = short.usedPercent >= 99;
        var pill = el("span", "display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;"
          + "font-size:11.5px;cursor:default;background:var(--dsw-alias-bg-base,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);",
          (exhausted ? "Codex 已用尽" : "Codex " + pillText(short))
          + (long ? " · 周 " + pillText(long) : "")
          + (exhausted && short.resetsAt ? " · " + time(short.resetsAt) + " 重置" : ""));
        pill.style.color = exhausted ? "#ef4444" : pillColor(short);
        elm.appendChild(pill);
      }
      function refresh() {
        api("GET", "/status").then(function (s) {
          if (s && s.providers) providersRef.list = s.providers;
          render(s);
        }).catch(function () {});
      }
      function checkVisibility() {
        try {
          var dir = ctx.get("modelDirectories");
          if (!dir) { visible = false; elm.textContent = ""; return; }
          var current = dir.directoryFor(sessionId).store.getSnapshot().current;
          var on = current && providersRef.list.indexOf(current.provider) >= 0;
          if (on === visible) return;
          visible = on;
          elm.textContent = "";
          if (on) refresh();
        } catch (e) { visible = false; elm.textContent = ""; }
      }
      try {
        var dirs = ctx.get("modelDirectories");
        if (dirs) {
          unsubscribe = dirs.directoryFor(sessionId).store.subscribe(function () { checkVisibility(); }) || function () {};
        }
      } catch (e) {}
      checkVisibility();
      // Session creation does not emit a model-directory change, so the gate
      // re-checks itself on the poll instead of waiting for a switch.
      timer = setInterval(function () { checkVisibility(); if (visible) refresh(); }, 60000);
      return function () {
        stop = true;
        clearInterval(timer);
        try { unsubscribe(); } catch (e) {}
      };
    }

    module.exports.inject = ["slots"];
    module.exports.apply = function (ctx) {
      var React = require("react");
      var Panel = function () {
        return React.createElement("div", {
          style: { height: "78vh", overflow: "auto", position: "relative" },
          ref: function (elm) {
            if (elm && !elm.__engineRouterInited) { elm.__engineRouterInited = 1; render(elm, elm); }
          },
        });
      };
      var doRegister = function () {
        return ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            { name: "settings.section", id: "dsh-oh-my-codex", order: 98, label: function () { return "Codex 引擎"; }, inject: function () { return {}; } },
            function () { return React.createElement(Panel); }
          );
        });
      };
      if (typeof ctx.effect === "function") ctx.effect(doRegister, "oh-my-codex: settings section");
      else doRegister();

      var doPill = function () {
        return ctx.slots.inject("conversation.input.right", function () {
          var providersRef = { list: [] };
          var Pill = function (props) {
            return React.createElement("span", {
              style: { display: "inline-flex", alignItems: "center" },
              ref: function (elm) {
                if (elm && !elm.__omcPill) {
                  elm.__omcPill = 1;
                  // Mount only after the managed-provider list arrives: the
                  // visibility gate would otherwise compare against an empty
                  // list and nothing re-checks after the fetch resolves.
                  api("GET", "/status").then(function (s) {
                    if (s && s.providers) providersRef.list = s.providers;
                  }).catch(function () {}).finally(function () {
                    if (elm.isConnected) elm.__omcDispose = mountPill(elm, props.sessionId, providersRef, ctx);
                  });
                }
              },
            });
          };
          return ctx.slots.register(
            { name: "conversation.input.right", id: "dsh-oh-my-codex-quota", order: 20,
              inject: function (sessionId) { return { sessionId: sessionId }; } },
            function (slotProps) { return React.createElement(Pill, slotProps); }
          );
        });
      };
      if (typeof ctx.effect === "function") ctx.effect(doPill, "oh-my-codex: composer quota pill");
      else doPill();
    };
    return module.exports;
  }
});
