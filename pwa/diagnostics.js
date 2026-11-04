"use strict";
// BE-04: UI254 presentation with explicit-consent live transport; metadata only.
window.SvitloDiagnostics = (() => {
  const stages = ["city", "street", "house", "submit"],
    codes = ["empty", "temporary", "timeout", "offline"];
  function packet(context, target, id, at) {
    if (
      !stages.includes(context.stage) ||
      !codes.includes(context.code) ||
      !["android", "pwa"].includes(target)
    )
      throw new Error("Invalid diagnostic context");
    if (!/^[a-f0-9-]{36}$/i.test(id) || !Number.isFinite(Date.parse(at)))
      throw new Error("Invalid diagnostic identity");
    const data = {
      schemaVersion: 1,
      reportId: id,
      client: { target, version: "2.0.0-pilot.1" },
      occurredAt: at,
      stage: context.stage,
      code: context.code,
      events: [{ name: "lookup_failed", code: context.code }],
    };
    if (
      Number.isInteger(context.httpStatus) &&
      context.httpStatus >= 100 &&
      context.httpStatus <= 599
    )
      data.httpStatus = context.httpStatus;
    if (
      typeof context.correlationId === "string" &&
      /^[A-Za-z0-9_-]{8,64}$/.test(context.correlationId)
    )
      data.correlationId = context.correlationId;
    return data;
  }
  function create(ctx) {
    let draft = null,
      timer = null,
      token = 0,
      attempt = 0;
    function cancel() {
      token++;
      timer?.abort?.();
      timer = null;
      draft = null;
      attempt = 0;
    }
    function preview() {
      ctx.dialog(
        "Повідомити про помилку",
        `<p>Ці технічні дані допоможуть команді «Світло» перевірити помилку. Адреси, GPS та дані облікового запису не додаються.</p><pre class="diagnostic-preview">${ctx.esc(JSON.stringify(draft, null, 2))}</pre>`,
        ctx.button("Скасувати", "report-cancel", "cancel") +
          ctx.button("Надіслати", "report-send"),
        "",
        { footerClass: "paired" },
      );
    }
    function open(context) {
      cancel();
      draft = packet(
        context,
        ctx.getState().target,
        crypto.randomUUID(),
        new Date().toISOString(),
      );
      preview();
    }
    async function send() {
      if (!draft || timer !== null || attempt >= 2) return;
      const request = draft, seq = ++token;attempt++;
      const controller=new AbortController();timer=controller;
      ctx.dialog("Перевірка звіту",'<p role="status">Надсилаю…</p>',ctx.button("Скасувати", "report-cancel", "cancel"));
      try {
        await window.SvitloLive.diagnostic(request,controller.signal);
        if(seq!==token||draft!==request)return;
        ctx.dialog("Звіт перевірено",`<div class="character-dialog"><img src="assets/mascot-technician.webp" width="104" height="104" alt=""><div class="character-speech" role="status">Дякую, що допомагаєш покращувати «Світло»!</div></div>`,ctx.button("Зрозуміло", "report-cancel"),"",{footerClass:"centered",character:true});
      } catch {
        if(seq!==token||draft!==request)return;
        ctx.dialog("Не вдалося надіслати",'<div class="character-dialog"><img src="assets/mascot-technician.webp" width="104" height="104" alt=""><div class="character-speech" role="status">Не зміг надіслати звіт. Спробуємо ще раз?</div></div>',ctx.button("Скасувати", "report-cancel", "cancel")+ctx.button("Спробувати ще", "report-send"),"",{footerClass:"paired",character:true});
      } finally { if(seq===token)timer=null; }
    }
    return {
      open,
      cancel,
      active: () => !!draft,
      handle(name) {
        if (!name.startsWith("report-")) return false;
        if (name === "report-send") send();
        else if (name === "report-cancel") {
          cancel();
          ctx.close();
        }
        return true;
      },
    };
  }
  return { packet, create };
})();
