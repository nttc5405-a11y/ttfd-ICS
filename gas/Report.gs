/**
 * 報表看板的統計數字（甘特圖前端直接重用 getIcsBoard 的場地/任務資料，這裡只算統計表）。
 *
 * 指標定義（見 SPEC 統計定義）：
 * - 人數：不重複 person_id 數
 * - 人次：TaskMembers 筆數
 * - 人時：每筆出勤 (離開時間－加入時間) 加總，未結束的用「現在」算
 * - 報到人數：Personnel 裡報到過的人數（含未出勤者）
 * 分日檢視：某人當天有任一出勤時段落在該日即計入當天人數；人時在午夜切段分別計算。
 * 「工作場地」分組的報到人數不計算（打 － ）：報到位置 checkin_zone 是自由文字，
 * 跟 Sites 的實際場地記錄對不起來，硬湊會誤導。
 */

/**
 * action: getReport
 * body: { action:'getReport', token, case_id, mode:'all'|'day', date:'YYYY-MM-DD'（mode=day 時必填）, group_by:'unit'|'sub_unit'|'site' }
 */
function handleGetReport_(body) {
  var caseId = body.case_id;
  requireAuth_(body.token, 'view', caseId);

  var mode = body.mode === 'day' ? 'day' : 'all';
  var groupBy = ['unit', 'sub_unit', 'site'].indexOf(body.group_by) !== -1 ? body.group_by : 'unit';

  var dayStart = null;
  var dayEnd = null;
  if (mode === 'day') {
    var dateStr = String(body.date || '');
    if (!dateStr) return { ok: false, error: '請選擇日期' };
    dayStart = new Date(dateStr + 'T00:00:00+08:00');
    if (isNaN(dayStart.getTime())) return { ok: false, error: '日期格式不正確' };
    dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  }

  var personnel = sheetToObjects_(getSheet_('Personnel')).filter(function (p) { return p.case_id === caseId; });
  var personnelById = {};
  personnel.forEach(function (p) { personnelById[p.person_id] = p; });

  var tasks = sheetToObjects_(getSheet_('Tasks')).filter(function (t) { return t.case_id === caseId; });
  var tasksById = {};
  tasks.forEach(function (t) { tasksById[t.task_id] = t; });

  var sites = sheetToObjects_(getSheet_('Sites')).filter(function (s) { return s.case_id === caseId; });
  var siteNameById = {};
  sites.forEach(function (s) { siteNameById[s.site_id] = s.name; });

  var taskMembers = sheetToObjects_(getSheet_('TaskMembers')).filter(function (tm) {
    return personnelById.hasOwnProperty(tm.person_id);
  });

  var now = new Date();
  var groups = {};

  function ensureGroup(key) {
    if (!groups[key]) groups[key] = { personIds: {}, visits: 0, hours: 0, checkinCount: 0 };
    return groups[key];
  }

  function groupKeyFor(tm, task) {
    var p = personnelById[tm.person_id];
    if (groupBy === 'unit') return p.unit || '（未填單位）';
    if (groupBy === 'sub_unit') return p.sub_unit || '（未填子單位）';
    var siteId = task ? task.site_id : '';
    return siteNameById[siteId] || '（未知場地）';
  }

  taskMembers.forEach(function (tm) {
    var task = tasksById[tm.task_id];
    var joined = new Date(tm.joined_at);
    var left = tm.left_at ? new Date(tm.left_at) : now;

    var effStart = joined;
    var effEnd = left;
    if (mode === 'day') {
      effStart = joined > dayStart ? joined : dayStart;
      effEnd = left < dayEnd ? left : dayEnd;
      if (effStart >= effEnd) return; // 這天沒有交集
    }

    var key = groupKeyFor(tm, task);
    var g = ensureGroup(key);
    g.personIds[tm.person_id] = true;
    g.visits += 1;
    g.hours += (effEnd - effStart) / 3600000;
  });

  if (groupBy !== 'site') {
    personnel.forEach(function (p) {
      if (!p.checkin_at) return;
      if (mode === 'day') {
        var checkinAt = new Date(p.checkin_at);
        if (checkinAt < dayStart || checkinAt >= dayEnd) return;
      }
      var key = groupBy === 'unit' ? (p.unit || '（未填單位）') : (p.sub_unit || '（未填子單位）');
      ensureGroup(key).checkinCount += 1;
    });
  }

  var rows = Object.keys(groups).map(function (key) {
    var g = groups[key];
    return {
      group: key,
      person_count: Object.keys(g.personIds).length,
      visit_count: g.visits,
      hours: Math.round(g.hours * 10) / 10,
      checkin_count: groupBy !== 'site' ? g.checkinCount : null
    };
  }).sort(function (a, b) { return a.group < b.group ? -1 : (a.group > b.group ? 1 : 0); });

  return { ok: true, group_by: groupBy, mode: mode, rows: rows };
}
