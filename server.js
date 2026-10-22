/*
 * 교실 자리배치 · 청소 역할 — 로컬 실행 서버
 *
 * 이 파일을 직접 실행할 필요는 없습니다. "start.bat" 을 더블클릭하세요.
 *
 * 하는 일
 *   1) 이 폴더를 http://localhost:7315 로 띄운다
 *   2) data.sqlite (SQLite 데이터베이스) 를 읽어 주고(GET), 바뀌면 다시 써 준다(PUT)
 *   3) 기본 브라우저를 자동으로 연다
 *
 * 저장은 SQLite 로 한다. 화면 쪽과 주고받는 형식(JSON)은 그대로라서
 * 브라우저 코드는 저장 방식이 바뀐 것을 알 필요가 없다.
 * 예전 data.json 이 있으면 처음 켤 때 자동으로 옮겨 담는다.
 */
"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT      = __dirname;
const DATA_DIR  = path.join(ROOT, "data");          // 저장 파일은 전부 이 안에
const BAK_DIR   = path.join(DATA_DIR, "backup");
const DB_FILE   = path.join(DATA_DIR, "data.sqlite");
const BAK_FILE  = path.join(BAK_DIR, "data.backup.sqlite");
const OLD_JSON  = path.join(ROOT, "data.json");

// 폴더를 만들고, 예전처럼 프로그램 폴더에 있던 저장 파일은 data 안으로 옮긴다.
// (WAL 은 본 파일과 짝이라 세 개를 함께 옮겨야 한다)
fs.mkdirSync(BAK_DIR, { recursive:true });
for(const [from, to] of [[path.join(ROOT, "data.sqlite"), DB_FILE],
                         [path.join(ROOT, "data.sqlite-wal"), DB_FILE + "-wal"],
                         [path.join(ROOT, "data.sqlite-shm"), DB_FILE + "-shm"]]){
  try{ if(fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to); }catch(e){}
}
const BASE_PORT = 7315;
const MAX_TRY   = 10;

const MIME = {
  ".html":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
  ".gif":"image/gif", ".svg":"image/svg+xml", ".ico":"image/x-icon",
  ".woff":"font/woff", ".woff2":"font/woff2", ".ttf":"font/ttf"
};

function send(res, code, body, type, headers = {}){
  res.writeHead(code, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

/* ── 데이터베이스 ──────────────────────────── */
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS meta(
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS student(
    no   INTEGER PRIMARY KEY,          -- 출석번호
    name TEXT NOT NULL,
    role TEXT,                         -- 회장 / 부회장 등
    ord  INTEGER NOT NULL              -- 명단 순서
  );
  CREATE TABLE IF NOT EXISTS seat(
    idx        INTEGER PRIMARY KEY,    -- 좌석 위치 (0부터)
    student_no INTEGER,                -- 지금 앉은 학생
    base_no    INTEGER,                -- 마지막 랜덤 배치 기준
    locked     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS area(
    id   TEXT PRIMARY KEY,             -- 청소 구역
    name TEXT NOT NULL,
    tier TEXT NOT NULL,                -- easy / mid / hard
    cap  INTEGER NOT NULL,
    ord  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS area_student(
    area_id    TEXT NOT NULL,
    student_no INTEGER NOT NULL,
    kind       TEXT NOT NULL,          -- assign(현재) / base(기준)
    ord        INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seat_hist(              -- 자리 배치 기록 (최신이 ord 0)
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    at   TEXT NOT NULL,
    rows INTEGER NOT NULL,
    cols INTEGER NOT NULL,
    ord  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seat_hist_item(
    hist_id    INTEGER NOT NULL,
    idx        INTEGER NOT NULL,               -- 좌석 위치
    student_no INTEGER                         -- 빈자리는 NULL
  );
  CREATE TABLE IF NOT EXISTS clean_locked(  student_no INTEGER PRIMARY KEY );
  CREATE TABLE IF NOT EXISTS clean_excluded(student_no INTEGER PRIMARY KEY );
  CREATE TABLE IF NOT EXISTS clean_badly(   student_no INTEGER PRIMARY KEY );  -- 청소 못한 학생
  CREATE TABLE IF NOT EXISTS clean_check(        -- 종이로 세서 직접 넣은 횟수
    student_no INTEGER PRIMARY KEY,
    n          INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clean_mark(         -- 체크 (주 × 학생 × 점검항목 × 요일)
    week       TEXT NOT NULL,                    -- 그 주 월요일 (YYYY-MM-DD)
    student_no INTEGER NOT NULL,
    item       INTEGER NOT NULL,                 -- 그 구역의 몇 번째 점검 기준인지
    day        INTEGER NOT NULL,                 -- 0 월 ~ 4 금
    PRIMARY KEY(week, student_no, item, day)
  );
  CREATE TABLE IF NOT EXISTS area_check(         -- 구역별 점검 기준
    area_id TEXT NOT NULL,
    ord     INTEGER NOT NULL,
    text    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draw(
    id  INTEGER PRIMARY KEY AUTOINCREMENT,
    at  TEXT NOT NULL,
    ord INTEGER NOT NULL               -- 0 이 가장 최근
  );
  CREATE TABLE IF NOT EXISTS draw_area(          -- 그 회차에 쓰던 구역 설정
    draw_id INTEGER NOT NULL,
    id      TEXT NOT NULL,
    name    TEXT NOT NULL,
    tier    TEXT NOT NULL,
    cap     INTEGER NOT NULL,
    ord     INTEGER NOT NULL,
    outside INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS clean_pending(      -- 다음 배치에 쓰려고 미리 잡아 둔 구역
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    tier    TEXT NOT NULL,
    cap     INTEGER NOT NULL,
    ord     INTEGER NOT NULL,
    outside INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS draw_item(
    draw_id    INTEGER NOT NULL,
    student_no INTEGER NOT NULL,
    area_id    TEXT NOT NULL,
    tier       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draw_check(           -- 그 회차를 확정할 때의 체크 횟수
    draw_id    INTEGER NOT NULL,                   -- (확정하면 체크가 0으로 지워지므로 여기 남긴다)
    student_no INTEGER NOT NULL,
    n          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_area_student ON area_student(kind, area_id);
  CREATE INDEX IF NOT EXISTS ix_draw_item    ON draw_item(draw_id);
  CREATE INDEX IF NOT EXISTS ix_draw_check   ON draw_check(draw_id);
  CREATE INDEX IF NOT EXISTS ix_seat_hist    ON seat_hist_item(hist_id);
  CREATE INDEX IF NOT EXISTS ix_draw_area    ON draw_area(draw_id);
  CREATE INDEX IF NOT EXISTS ix_area_check   ON area_check(area_id);
`);

// clean_mark 에 주(week) 개념이 없던 시절의 표는 이번 주 것으로 옮겨 담는다.
{
  let cols = db.prepare("PRAGMA table_info(clean_mark)").all();
  if(cols.length && !cols.some(c => c.name === "week")){
    const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const mon = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") +
                "-" + String(d.getDate()).padStart(2,"0");
    const old = db.prepare("SELECT student_no,day FROM clean_mark").all();
    db.exec("DROP TABLE clean_mark");
    db.exec("CREATE TABLE clean_mark(week TEXT NOT NULL, student_no INTEGER NOT NULL, " +
            "day INTEGER NOT NULL, PRIMARY KEY(week, student_no, day))");
    const ins = db.prepare("INSERT OR IGNORE INTO clean_mark(week,student_no,day) VALUES(?,?,?)");
    for(const r of old) ins.run(mon, r.student_no, r.day);
    cols = db.prepare("PRAGMA table_info(clean_mark)").all();
  }
  // 점검 항목(item) 이 없던 시절의 체크는 첫 번째 항목 것으로 본다
  if(cols.length && !cols.some(c => c.name === "item")){
    const old = db.prepare("SELECT week,student_no,day FROM clean_mark").all();
    db.exec("DROP TABLE clean_mark");
    db.exec("CREATE TABLE clean_mark(week TEXT NOT NULL, student_no INTEGER NOT NULL, " +
            "item INTEGER NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(week, student_no, item, day))");
    const ins = db.prepare("INSERT OR IGNORE INTO clean_mark(week,student_no,item,day) VALUES(?,?,?,?)");
    for(const r of old) ins.run(r.week, r.student_no, 0, r.day);
  }
}

// area.outside : 외부청소 구역 표시. 예전 DB 에는 없던 열이라 한 번만 붙인다.
if(!db.prepare("PRAGMA table_info(area)").all().some(c => c.name === "outside")){
  db.exec("ALTER TABLE area ADD COLUMN outside INTEGER NOT NULL DEFAULT 0");
  // 처음 한 번만 : 이름으로 알아볼 수 있는 외부청소 구역을 켜 둔다
  db.exec("UPDATE area SET outside = 1 WHERE name LIKE '교사회의실%' OR name LIKE '과학실%'");
}

// Preserve an explicitly empty checklist, including pending and historical areas.
for(const table of ["area", "clean_pending", "draw_area"]){
  if(!db.prepare("PRAGMA table_info(" + table + ")").all().some(c => c.name === "checks_json"))
    db.exec("ALTER TABLE " + table + " ADD COLUMN checks_json TEXT");
}
function areaJSON(a){
  const result = { id:a.id, name:a.name, tier:a.tier, cap:a.cap, outside:!!a.outside };
  if(a.checks_json != null){
    try{ const checks = JSON.parse(a.checks_json); if(Array.isArray(checks)) result.checks = checks; }catch(e){}
  }
  return result;
}
const checksJSON = a => Array.isArray(a.checks) ? JSON.stringify(a.checks.map(String)) : null;

const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
const setMeta = db.prepare("INSERT INTO meta(key,value) VALUES(?,?) " +
                           "ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const m  = k => { const r = getMeta.get(k); return r ? r.value : null; };
const mj = (k, dflt) => { const v = m(k); if(v == null) return dflt;
                          try{ return JSON.parse(v); }catch(e){ return dflt; } };

/* ── 읽기 : DB → 화면이 쓰는 JSON 모양 ─────── */
function loadAll(){
  const students = db.prepare("SELECT no,name,role FROM student ORDER BY ord").all()
    .map(r => r.role ? { no:r.no, name:r.name, role:r.role } : { no:r.no, name:r.name });
  if(!students.length && !m("rows")) return {};        // 아직 아무것도 없음

  const idxOf = new Map(students.map((s, i) => [s.no, i]));   // 번호 → 명단 위치
  const rows = +m("rows") || 5, cols = +m("cols") || 6, n = rows * cols;

  const seats = new Array(n).fill(null);
  const base  = new Array(n).fill(null);
  const locked = new Array(n).fill(false);
  for(const r of db.prepare("SELECT idx,student_no,base_no,locked FROM seat ORDER BY idx").all()){
    if(r.idx < 0 || r.idx >= n) continue;
    seats[r.idx]  = idxOf.has(r.student_no) ? idxOf.get(r.student_no) : null;
    base[r.idx]   = idxOf.has(r.base_no)    ? idxOf.get(r.base_no)    : null;
    locked[r.idx] = !!r.locked;
  }

  const areas = db.prepare("SELECT id,name,tier,cap,outside,checks_json FROM area ORDER BY ord").all()
    .map(areaJSON);
  {
    const byArea = {};
    for(const r of db.prepare("SELECT area_id,text FROM area_check ORDER BY area_id, ord").all())
      (byArea[r.area_id] || (byArea[r.area_id] = [])).push(r.text);
    for(const a of areas) if(byArea[a.id]) a.checks = byArea[a.id];
  }
  const assign = {}, cbase = {};
  for(const a of areas){ assign[a.id] = []; cbase[a.id] = []; }
  for(const r of db.prepare("SELECT area_id,student_no,kind FROM area_student ORDER BY kind, area_id, ord").all()){
    const bag = r.kind === "base" ? cbase : assign;
    if(bag[r.area_id]) bag[r.area_id].push(r.student_no);
  }

  const seatHist = [];
  for(const h of db.prepare("SELECT id,at,rows,cols FROM seat_hist ORDER BY ord").all()){
    const list = new Array(h.rows * h.cols).fill(null);
    for(const it of db.prepare("SELECT idx,student_no FROM seat_hist_item WHERE hist_id = ?").all(h.id))
      if(it.idx >= 0 && it.idx < list.length) list[it.idx] = it.student_no;
    seatHist.push({ at:h.at, rows:h.rows, cols:h.cols, seats:list });
  }

  const history = [];
  for(const d of db.prepare("SELECT id,at FROM draw ORDER BY ord").all()){
    const rec = {};
    for(const it of db.prepare("SELECT student_no,area_id,tier FROM draw_item WHERE draw_id = ?").all(d.id))
      rec[it.student_no] = { a:it.area_id, t:it.tier };
    const ha = db.prepare("SELECT id,name,tier,cap,outside,checks_json FROM draw_area WHERE draw_id = ? ORDER BY ord").all(d.id)
      .map(areaJSON);
    const chk = {};
    for(const c of db.prepare("SELECT student_no,n FROM draw_check WHERE draw_id = ?").all(d.id))
      if(c.n > 0) chk[c.student_no] = c.n;
    const one = ha.length ? { at:d.at, rec, areas:ha } : { at:d.at, rec };
    if(Object.keys(chk).length) one.chk = chk;     // 없던 시절 기록에는 붙지 않는다
    history.push(one);
  }

  const pending = db.prepare("SELECT id,name,tier,cap,outside,checks_json FROM clean_pending ORDER BY ord").all()
    .map(areaJSON);

  const out = Object.assign({}, mj("extra", {}), {
    v: 3,
    savedAt: m("savedAt") || new Date().toISOString(),
    title: m("title") || "",
    showTitle: m("showTitle") !== "0",
    rows, cols, students, seats, base, locked,
    seatHistory: seatHist,
    cleaning: {
      title: m("cleanTitle") || "청소 역할",
      areas, assign, base: cbase, history,
      locked:   db.prepare("SELECT student_no FROM clean_locked").all().map(r => r.student_no),
      excluded: db.prepare("SELECT student_no FROM clean_excluded").all().map(r => r.student_no),
      badly:    db.prepare("SELECT student_no FROM clean_badly").all().map(r => r.student_no),
      checks:   Object.fromEntries(db.prepare("SELECT student_no,n FROM clean_check").all()
                  .map(r => [r.student_no, r.n])),
      marks:    (() => {
                  // { 주 : { 번호 : { 항목 : [요일…] } } }
                  const m = {};
                  for(const r of db.prepare("SELECT week,student_no,item,day FROM clean_mark " +
                                            "ORDER BY week,student_no,item,day").all()){
                    const wk = m[r.week]        || (m[r.week] = {});
                    const st = wk[r.student_no] || (wk[r.student_no] = {});
                    (st[r.item] || (st[r.item] = [])).push(r.day);
                  }
                  return m;
                })(),
      pending: pending.length ? pending : null,
      chief:   m("chief")   == null ? null : +m("chief"),
      vice:    m("vice")    == null ? null : +m("vice"),
      captain: m("captain") == null ? null : +m("captain"),
      roles:   mj("cleanRoles", null) || null,     // 없으면 화면이 옛 셋으로 만들어 준다
      survey:  mj("cleanSurvey", null) || null
    }
  });
  return out;
}

/* ── 쓰기 : 화면이 보낸 JSON → DB ──────────── */
const MODELLED = new Set(["v","savedAt","title","showTitle","rows","cols",
                          "students","seats","base","locked","cleaning","names",
                          "seatHistory"]);

function saveAll(obj, expectedRevision){
  const students = Array.isArray(obj.students) ? obj.students : [];
  const noAt = i => (Number.isInteger(i) && students[i]) ? students[i].no : null;  // 명단 위치 → 번호
  const C = (obj.cleaning && typeof obj.cleaning === "object") ? obj.cleaning : {};

  const extra = {};
  for(const k in obj) if(!MODELLED.has(k)) extra[k] = obj[k];

  db.exec("BEGIN IMMEDIATE");
  try{
    const revision = +(m("revision") || 0);
    if(expectedRevision !== undefined && expectedRevision !== revision){
      const error = new Error("다른 창에서 내용이 변경되었습니다.");
      error.status = 409;
      throw error;
    }
    for(const t of ["student","seat","area","area_student","clean_locked","clean_excluded",
                    "clean_badly","clean_check","clean_mark","area_check",
                    "draw","draw_item","draw_area","draw_check","clean_pending",
                    "seat_hist","seat_hist_item"])
      db.exec("DELETE FROM " + t);

    const pairs = {
      title: obj.title || "", showTitle: obj.showTitle === false ? "0" : "1",
      rows: String(+obj.rows || 5), cols: String(+obj.cols || 6),
      savedAt: obj.savedAt || new Date().toISOString(),
      cleanTitle: C.title || "청소 역할",
      chief:   C.chief   == null ? null : String(C.chief),
      vice:    C.vice    == null ? null : String(C.vice),
      captain: C.captain == null ? null : String(C.captain),
      cleanRoles:  Array.isArray(C.roles) && C.roles.length ? JSON.stringify(C.roles) : null,
      cleanSurvey: C.survey && typeof C.survey === "object" ? JSON.stringify(C.survey) : null,
      extra: JSON.stringify(extra)
    };
    for(const k in pairs) setMeta.run(k, pairs[k]);

    const insS = db.prepare("INSERT INTO student(no,name,role,ord) VALUES(?,?,?,?)");
    students.forEach((s, i) => {
      if(s && s.name != null) insS.run(+s.no || i + 1, String(s.name), s.role || null, i);
    });

    const insSeat = db.prepare("INSERT INTO seat(idx,student_no,base_no,locked) VALUES(?,?,?,?)");
    const seats = Array.isArray(obj.seats) ? obj.seats : [];
    const bs    = Array.isArray(obj.base) ? obj.base : [];
    const lk    = Array.isArray(obj.locked) ? obj.locked : [];
    seats.forEach((v, i) => insSeat.run(i, noAt(v), noAt(bs[i]), lk[i] ? 1 : 0));

    const insH  = db.prepare("INSERT INTO seat_hist(at,rows,cols,ord) VALUES(?,?,?,?)");
    const insHI = db.prepare("INSERT INTO seat_hist_item(hist_id,idx,student_no) VALUES(?,?,?)");
    (Array.isArray(obj.seatHistory) ? obj.seatHistory : []).forEach((h, i) => {
      if(!h || !Array.isArray(h.seats)) return;
      const r = +h.rows || 5, c = +h.cols || 6;
      const id = insH.run(h.at || new Date().toISOString(), r, c, i).lastInsertRowid;
      h.seats.forEach((no, k) => insHI.run(Number(id), k, Number.isFinite(+no) ? +no : null));
    });

    const insA = db.prepare("INSERT INTO area(id,name,tier,cap,ord,outside,checks_json) VALUES(?,?,?,?,?,?,?)");
    const areas = Array.isArray(C.areas) ? C.areas : [];
    areas.forEach((a, i) => {
      if(a && a.id) insA.run(String(a.id), String(a.name || "구역"), String(a.tier || "easy"),
                             +a.cap || 1, i, a.outside ? 1 : 0, checksJSON(a));
    });

    const insAS = db.prepare("INSERT INTO area_student(area_id,student_no,kind,ord) VALUES(?,?,?,?)");
    for(const [kind, bag] of [["assign", C.assign], ["base", C.base]]){
      if(!bag || typeof bag !== "object") continue;
      for(const id in bag)
        (bag[id] || []).forEach((no, i) => { if(Number.isFinite(+no)) insAS.run(String(id), +no, kind, i); });
    }

    const insL = db.prepare("INSERT OR IGNORE INTO clean_locked(student_no) VALUES(?)");
    for(const no of (Array.isArray(C.locked) ? C.locked : [])) if(Number.isFinite(+no)) insL.run(+no);
    const insE = db.prepare("INSERT OR IGNORE INTO clean_excluded(student_no) VALUES(?)");
    for(const no of (Array.isArray(C.excluded) ? C.excluded : [])) if(Number.isFinite(+no)) insE.run(+no);
    const insB = db.prepare("INSERT OR IGNORE INTO clean_badly(student_no) VALUES(?)");
    for(const no of (Array.isArray(C.badly) ? C.badly : [])) if(Number.isFinite(+no)) insB.run(+no);

    const insCk = db.prepare("INSERT OR REPLACE INTO clean_check(student_no,n) VALUES(?,?)");
    const ck = (C.checks && typeof C.checks === "object") ? C.checks : {};
    for(const no in ck) if(Number.isFinite(+no) && +ck[no] > 0) insCk.run(+no, +ck[no]);

    const insMk = db.prepare("INSERT OR IGNORE INTO clean_mark(week,student_no,item,day) VALUES(?,?,?,?)");
    const mk = (C.marks && typeof C.marks === "object") ? C.marks : {};
    const isWeek = w => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(w);
    for(const wk in mk){
      if(!isWeek(wk) || !mk[wk] || typeof mk[wk] !== "object") continue;
      for(const no in mk[wk]){
        const st = mk[wk][no];
        if(!Number.isFinite(+no) || !st || typeof st !== "object") continue;
        // 예전 모양([요일…])이면 첫 항목 것으로 본다
        const items = Array.isArray(st) ? { 0:st } : st;
        for(const it in items){
          if(!Array.isArray(items[it])) continue;
          for(const d of items[it])
            if(Number.isInteger(+d) && +d >= 0 && +d < 7) insMk.run(wk, +no, +it || 0, +d);
        }
      }
    }

    const insAC = db.prepare("INSERT INTO area_check(area_id,ord,text) VALUES(?,?,?)");
    for(const a of (Array.isArray(C.areas) ? C.areas : [])){
      if(!a || !a.id || !Array.isArray(a.checks)) continue;
      a.checks.forEach((t, i) => { if(String(t).trim()) insAC.run(String(a.id), i, String(t).trim()); });
    }

    const insP = db.prepare("INSERT INTO clean_pending(id,name,tier,cap,ord,outside,checks_json) VALUES(?,?,?,?,?,?,?)");
    (Array.isArray(C.pending) ? C.pending : []).forEach((a, i) => {
      if(a && a.id) insP.run(String(a.id), String(a.name || "구역"), String(a.tier || "easy"),
                             +a.cap || 1, i, a.outside ? 1 : 0, checksJSON(a));
    });

    const insD  = db.prepare("INSERT INTO draw(at,ord) VALUES(?,?)");
    const insDI = db.prepare("INSERT INTO draw_item(draw_id,student_no,area_id,tier) VALUES(?,?,?,?)");
    const insDA = db.prepare("INSERT INTO draw_area(draw_id,id,name,tier,cap,ord,outside,checks_json) VALUES(?,?,?,?,?,?,?,?)");
    const insDC = db.prepare("INSERT INTO draw_check(draw_id,student_no,n) VALUES(?,?,?)");
    (Array.isArray(C.history) ? C.history : []).forEach((h, i) => {
      if(!h || !h.rec) return;
      const id = insD.run(h.at || new Date().toISOString(), i).lastInsertRowid;
      for(const no in h.rec){
        const r = h.rec[no];
        if(r && r.a) insDI.run(Number(id), +no, String(r.a), String(r.t || "easy"));
      }
      (Array.isArray(h.areas) ? h.areas : []).forEach((a, k) => {
        if(a && a.id) insDA.run(Number(id), String(a.id), String(a.name || "구역"),
                                String(a.tier || "easy"), +a.cap || 1, k, a.outside ? 1 : 0, checksJSON(a));
      });
      if(h.chk && typeof h.chk === "object")
        for(const no in h.chk){
          const n = Math.round(+h.chk[no]);
          if(n > 0) insDC.run(Number(id), +no, n);
        }
    });

    setMeta.run("revision", String(revision + 1));
    db.exec("COMMIT");
    return revision + 1;
  }catch(e){
    try{ db.exec("ROLLBACK"); }catch(e2){}
    throw e;
  }
}

/* ── 예전 data.json 을 한 번만 옮겨 담는다 ─── */
function migrateJson(){
  if(!fs.existsSync(OLD_JSON)) return;
  if(db.prepare("SELECT COUNT(*) c FROM student").get().c > 0) return;   // 이미 내용이 있음
  try{
    const obj = JSON.parse(fs.readFileSync(OLD_JSON, "utf8"));
    saveAll(obj);
    fs.renameSync(OLD_JSON, path.join(BAK_DIR, "data.migrated.json"));
    console.log("  data.json 을 data.sqlite 로 옮겼습니다 (원본은 data.migrated.json 으로 보관).");
  }catch(e){
    console.log("  data.json 을 옮기지 못했습니다: " + e.message);
  }
}

/* ── 요청 처리 ─────────────────────────────── */
function readData(res){
  try{
    db.exec("BEGIN");
    const data = loadAll(), revision = m("revision") || "0";
    db.exec("COMMIT");
    send(res, 200, JSON.stringify(data), MIME[".json"], { ETag:'"' + revision + '"' });
  }catch(e){
    try{ db.exec("ROLLBACK"); }catch(ignored){}
    send(res, 500, "read failed");
  }
}

function writeData(req, res){
  const match = /^"(\d+)"$/.exec(req.headers["if-match"] || "");
  if(!match || !Number.isSafeInteger(+match[1]))
    return send(res, 428, "최신 프로그램 화면을 다시 열어 주세요.");
  let body = "";
  req.on("data", c => {
    body += c;
    if(body.length > 8e6){ req.destroy(); }
  });
  req.on("end", () => {
    let obj;
    try{ obj = JSON.parse(body); }
    catch(e){ return send(res, 400, "invalid json"); }
    if(!obj || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(obj.students))
      return send(res, 400, "invalid data");
    try{
      const revision = saveAll(obj, +match[1]);
      send(res, 200, '{"ok":true}', MIME[".json"], { ETag:'"' + revision + '"' });
    }catch(e){ send(res, e.status || 500, "save failed: " + e.message); }
  });
}

function serveStatic(urlPath, res){
  let rel;
  try{ rel = decodeURIComponent(urlPath); }
  catch(e){ return send(res, 400, "bad path"); }
  if(rel === "/" || rel === "") rel = "/index.html";

  // Only the application's public files are served, never source or database files.
  const publicFiles = new Set(["/index.html", "/cleaning.html", "/check.html", "/recover.html", "/persistence.js"]);
  if(!publicFiles.has(rel)) return send(res, 403, "forbidden");
  const file = path.join(ROOT, rel.slice(1));

  fs.readFile(file, (err, buf) => {
    if(err) return send(res, 404, "찾을 수 없습니다: " + rel);
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  });
}

/* ── 브라우저가 닫히면 스스로 종료 ─────────── */
// 화면이 몇 초마다 /api/ping 을 보낸다. 소식이 끊기면 프로그램을 끝낸다.
// (검은 창 없이 실행하므로 창을 닫아 끄는 방법을 대신한다)
// 크롬은 백그라운드 탭의 타이머를 1분에 한 번꼴로 늦춘다.
// 20초로 잡으면 창을 잠깐 덮어 두기만 해도 프로그램이 꺼져 저장이 실패한다.
const IDLE_MS  = 300000;   // 마지막 신호 후 5분간 조용하면 종료
const GRACE_MS = 180000;   // 켠 직후 브라우저가 열릴 때까지 기다리는 시간
let lastPing = 0;
const startedAt = Date.now();

setInterval(() => {
  const seen = lastPing || startedAt;
  const limit = lastPing ? IDLE_MS : GRACE_MS;
  if(Date.now() - seen > limit){
    console.log("브라우저가 닫혀 프로그램을 종료합니다.");
    process.exit(0);
  }
}, 5000).unref();

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  if(urlPath === "/api/data" || urlPath === "/api/ping") lastPing = Date.now();

  if(urlPath === "/api/ping"){
    lastPing = Date.now();
    return send(res, 200, '{"ok":true}', MIME[".json"]);
  }
  if(urlPath === "/api/data"){
    if(req.method === "GET")  return readData(res);
    if(req.method === "PUT")  return writeData(req, res);
    return send(res, 405, "method not allowed");
  }
  if(req.method !== "GET") return send(res, 405, "method not allowed");
  serveStatic(urlPath, res);
});

function openBrowser(url){
  if(process.env.NO_OPEN) return;
  exec(`cmd /c start "" "${url}"`, err => {
    if(err) console.log("브라우저를 자동으로 열지 못했습니다. 주소창에 직접 입력해 주세요: " + url);
  });
}

migrateJson();
function backupDatabase(){
  const temp = BAK_FILE + "." + process.pid + "." + Date.now() + ".tmp";
  try{
    db.prepare("VACUUM INTO ?").run(temp);
    const copy = new DatabaseSync(temp, { readOnly:true });
    try{
      const check = copy.prepare("PRAGMA quick_check").get();
      if(Object.values(check)[0] !== "ok") throw new Error("백업 무결성 검사 실패");
      copy.prepare("SELECT COUNT(*) FROM student").get();
    }finally{ copy.close(); }
    fs.renameSync(temp, BAK_FILE);
  }catch(e){
    try{ fs.unlinkSync(temp); }catch(ignored){}
    console.log("백업을 만들지 못했습니다. 기존 백업은 보존됩니다: " + e.message);
  }
}
backupDatabase();

let port = BASE_PORT, tries = 0;
server.on("error", err => {
  if(err.code === "EADDRINUSE"){
    if(++tries === 1){
      console.log("포트 " + port + " 사용 중 — 이미 실행 중이면 그 창이 열립니다.");
    }
    if(tries <= MAX_TRY){
      if(tries === 1) openBrowser("http://localhost:" + BASE_PORT + "/");
      port = BASE_PORT + tries;
      return server.listen(port, "127.0.0.1");
    }
  }
  console.log("서버를 시작하지 못했습니다: " + err.message);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const url = "http://localhost:" + port + "/";
  console.log("");
  console.log("  교실 자리배치 · 청소 역할");
  console.log("  ------------------------------------------");
  console.log("  주소   : " + url);
  console.log("  데이터 : " + DB_FILE + "  (SQLite)");
  console.log("");
  console.log("  브라우저가 자동으로 열립니다.");
  console.log("  ※ 이 검은 창을 닫으면 프로그램이 종료됩니다.");
  console.log("");
  if(tries === 0) openBrowser(url);
});
