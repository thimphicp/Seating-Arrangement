/* Local server storage: serialize writes and never overwrite another window's work. */
(function(){
  "use strict";
  if(!/^https?:$/.test(location.protocol)) return;
  const originalFetch = window.fetch.bind(window);
  let revision = null, queue = Promise.resolve(), pending = 0, conflict = false;
  let recoveryBody = null, notice = null;
  const isData = url => typeof url === "string" && /^\/?api\/data(?:\?|$)/.test(url);

  function showConflict(body){
    conflict = true;
    recoveryBody = body;
    try{ sessionStorage.setItem("classroom-unsaved-" + location.pathname, body); }catch(e){}
    if(notice) return;
    notice = document.createElement("div");
    notice.setAttribute("role", "alert");
    notice.style.cssText = "position:fixed;bottom:12px;left:12px;right:12px;z-index:100000;background:#fff4dd;color:#402800;border:1px solid #b88725;padding:14px;box-shadow:0 2px 12px #0003;font:14px sans-serif";
    const message = document.createElement("p");
    message.textContent = "다른 창에서 내용이 바뀌어 저장을 멈췄습니다. 현재 변경을 복구 파일로 보관한 뒤 최신 내용을 불러와 주세요.";
    const download = document.createElement("button");
    download.textContent = "현재 변경 내보내기";
    download.onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([recoveryBody], {type:"application/json"}));
      a.download = "배치프로그램-미저장-" + Date.now() + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const reload = document.createElement("button");
    reload.textContent = "최신 내용 불러오기";
    reload.style.marginLeft = "8px";
    reload.onclick = () => {
      if(confirm("현재 변경을 내보냈나요? 저장하지 못한 화면을 닫고 최신 내용을 불러옵니다.")) location.reload();
    };
    notice.append(message, download, reload);
    document.body.append(notice);
  }

  window.classroomStorage = {
    get blocked(){ return conflict; }, get pending(){ return pending > 0; },
    acceptRead(res){ revision = res.headers.get("ETag"); }
  };
  window.fetch = function(url, options){
    if(!isData(url)) return originalFetch(url, options);
    const opts = Object.assign({}, options);
    const method = String(opts.method || "GET").toUpperCase();
    if(method === "GET"){
      // A background reload must never replace the base of an outstanding write.
      if(pending || conflict) return Promise.reject(new Error("저장 중인 변경이 있습니다."));
      return originalFetch(url, opts);
    }
    if(method !== "PUT") return originalFetch(url, opts);
    const body = opts.body;
    pending++;
    const task = queue.then(async () => {
      if(conflict){
        showConflict(body);
        return new Response("다른 창의 변경을 먼저 확인해 주세요.", {status:409});
      }
      if(revision == null) throw new Error("저장할 내용을 먼저 불러와 주세요.");
      const headers = new Headers(opts.headers);
      headers.set("If-Match", revision);
      const res = await originalFetch(url, Object.assign({}, opts, {headers}));
      if(res.status === 409 || res.status === 428) showConflict(body);
      else if(res.ok) revision = res.headers.get("ETag");
      return res;
    }).finally(() => { pending--; });
    queue = task.catch(() => {});
    return task;
  };
})();
