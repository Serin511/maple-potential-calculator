import { useState, useMemo, useEffect, useDeferredValue } from "react";

/* ================================================================
   메이플스토리 잠재능력 재설정 장사 계산기
   - 등급업 확률/천장: 넥슨 공식 확률 페이지 (2026.07 확인)
   - 재설정 비용: 나무위키 '잠재능력' 문서 (공식 표 전사본)
   - 옵션 가중치: 나무위키 '잠재능력/옵션 목록' (공식 확률표 분수 변환)
   ================================================================ */

// ---------- 고정 데이터 ----------
const GRADE_UP = { epic: 0.035, unique: 0.014 }; // 미라클데이 ×2 (천장/옵션확률 불변)
const PITY = { epic: 42, unique: 107 };
const ESCAPE = { line2: 0.2, line3: 0.05 }; // 이탈 확률 (공식)

const COST_DEFAULT = {
  // 레벨 구간별 1회 비용 (메소)
  140: { epic: 16000000, unique: 34000000, legend: 40000000 },
  160: { epic: 17000000, unique: 36125000, legend: 42500000 },
  200: { epic: 18000000, unique: 38250000, legend: 45000000 },
  250: { epic: 20000000, unique: 42500000, legend: 50000000 },
};

// 부위별 옵션 풀 총 가중치 (에픽 / 유니크 / 레전드리)
const POOL_TOTALS = {
  acc:    { epic: 70, unique: 80,  legend: 117 }, // 벨트 외 장신구
  belt:   { epic: 70, unique: 96,  legend: 99 },
  hat:    { epic: 70, unique: 104, legend: 123 },
  glove:  { epic: 82, unique: 112, legend: 120 },
  shoes:  { epic: 70, unique: 104, legend: 108 },
  cape:   { epic: 70, unique: 96,  legend: 99 }, // 망토·어깨장식
  top:    { epic: 76, unique: 124, legend: 117 },
  bottom: { epic: 70, unique: 104, legend: 99 },
  heart:  { epic: 70, unique: 80,  legend: 81 },
};

const PART_LABELS = {
  acc: "벨트 외 장신구", belt: "벨트", hat: "모자", glove: "장갑", shoes: "신발",
  cape: "망토·어깨장식", top: "상의", bottom: "하의", heart: "기계심장",
};
const ARMOR_PARTS = ["hat", "glove", "shoes", "cape", "belt", "top", "bottom"];

// 레벨별 옵션 수치 (스탯% / 올스탯% / HP%)
const VALUES = {
  std: { stat: { epic: 6, unique: 9, legend: 12 }, all: { epic: 3, unique: 6, legend: 9 } },
  250: { stat: { epic: 7, unique: 10, legend: 13 }, all: { epic: 4, unique: 7, legend: 10 } },
};
const STATS = ["STR", "DEX", "INT", "LUK"];

// 부위 × 등급(tier)별 원자 옵션 목록 생성
function buildTierAtoms(part, tier, level) {
  const v = level === 250 ? VALUES[250] : VALUES.std;
  const atoms = [];
  const add = (key, kind, weight, value = 0, max = 0) =>
    weight > 0 && atoms.push({ key, kind, weight, value, max });

  // 공통 추적 옵션
  const sw = tier === "epic" ? 10 : tier === "unique" ? 10 : 12;
  STATS.forEach((s) => add(s, "stat", sw, v.stat[tier]));
  add("ALL", "all", tier === "epic" ? 4 : tier === "unique" ? 8 : 9, v.all[tier]);
  add("HP", "hp", tier === "epic" ? 10 : tier === "unique" ? 12 : 9, v.stat[tier]);

  // 부위 전용 (레전드리)
  if (tier === "legend") {
    if (part === "hat") { add("CD1", "cd", 7.5, 1); add("CD2", "cd", 7.5, 2); }
    if (part === "glove") add("CRIT", "crit", 12, 8);
    if (part === "acc") { add("DROP", "drop", 9, 1); add("MESO", "meso", 9, 1); }
  }
  // 중복 제한 옵션 (재설정 확률 재계산 규칙 반영용)
  const usefulW = {
    hat: { unique: 8, legend: 9 }, bottom: { unique: 8, legend: 0 },
    shoes: { unique: 8, legend: 9 }, glove: { unique: 8, legend: 9 },
  };
  if (usefulW[part] && usefulW[part][tier]) add("USEFUL", "useful", usefulW[part][tier], 0, 1);
  if (part === "top") {
    if (tier === "epic") add("INVT", "invulT", 6, 0, 1);
    if (tier === "unique") { add("INVT", "invulT", 8, 0, 1); add("INVP", "invulP", 8, 0, 2); }
    if (tier === "legend") { add("INVT", "invulT", 9, 0, 1); add("INVP", "invulP", 9, 0, 2); }
  }
  if (ARMOR_PARTS.includes(part) && (tier === "unique" || tier === "legend"))
    add("DMGIG", "dmgIg", tier === "unique" ? 16 : 18, 0, 2);

  const total = POOL_TOTALS[part][tier];
  const used = atoms.reduce((s, a) => s + a.weight, 0);
  add("OTHER", "other", Math.max(0, total - used));
  return { atoms, total };
}

// ---------- 롤 분포 열거 엔진 ----------
// grade의 3줄 조합을 중복 제한(최대1/최대2) 규칙까지 반영해 정확 열거
function enumerateRolls(part, level, grade, evalCombo) {
  const lowTier = grade === "legend" ? "unique" : "epic";
  const hiPool = buildTierAtoms(part, grade, level);
  const loPool = buildTierAtoms(part, lowTier, level);

  const excludedW = (pool, st) => {
    let w = 0;
    for (const a of pool.atoms) {
      if (a.kind === "useful" && st.useful) w += a.weight;
      else if (a.kind === "invulT" && st.invulT) w += a.weight;
      else if (a.kind === "invulP" && st.invulP >= 2) w += a.weight;
      else if (a.kind === "dmgIg" && st.dmgIg >= 2) w += a.weight;
    }
    return w;
  };
  const nextState = (st, a) => ({
    useful: st.useful || a.kind === "useful",
    invulT: st.invulT || a.kind === "invulT",
    invulP: st.invulP + (a.kind === "invulP" ? 1 : 0),
    dmgIg: st.dmgIg + (a.kind === "dmgIg" ? 1 : 0),
  });
  const skip = (a, st) =>
    (a.kind === "useful" && st.useful) || (a.kind === "invulT" && st.invulT) ||
    (a.kind === "invulP" && st.invulP >= 2) || (a.kind === "dmgIg" && st.dmgIg >= 2);

  const st0 = { useful: false, invulT: false, invulP: 0, dmgIg: 0 };
  // 1줄: 표기 등급 100%
  for (const a1 of hiPool.atoms) {
    const p1 = a1.weight / hiPool.total;
    if (p1 <= 0) continue;
    const st1 = nextState(st0, a1);
    // 2줄: 이탈 20% / 하위 80%
    for (const [tierP2, pool2] of [[ESCAPE.line2, hiPool], [1 - ESCAPE.line2, loPool]]) {
      const ex2 = excludedW(pool2, st1);
      for (const a2 of pool2.atoms) {
        if (skip(a2, st1)) continue;
        const p2 = tierP2 * (a2.weight / (pool2.total - ex2));
        if (p2 <= 0) continue;
        const st2 = nextState(st1, a2);
        // 3줄: 이탈 5% / 하위 95%
        for (const [tierP3, pool3] of [[ESCAPE.line3, hiPool], [1 - ESCAPE.line3, loPool]]) {
          const ex3 = excludedW(pool3, st2);
          for (const a3 of pool3.atoms) {
            if (skip(a3, st2)) continue;
            const p3 = tierP3 * (a3.weight / (pool3.total - ex3));
            if (p3 <= 0) continue;
            evalCombo(p1 * p2 * p3, a1, a2, a3);
          }
        }
      }
    }
  }
}

// 3줄 조합 → 수치 합산
function comboSums(a1, a2, a3, allstatCount) {
  const s = { STR: 0, DEX: 0, INT: 0, LUK: 0 };
  let hp = 0, crit = 0, cd = 0, drop = 0, meso = 0, allSum = 0;
  for (const a of [a1, a2, a3]) {
    if (a.kind === "stat") s[a.key] += a.value;
    else if (a.kind === "all") {
      allSum += a.value;
      if (allstatCount) STATS.forEach((k) => (s[k] += a.value));
    }
    else if (a.kind === "hp") hp += a.value;
    else if (a.kind === "crit") crit += a.value;
    else if (a.kind === "cd") cd += a.value;
    else if (a.kind === "drop") drop += 1;
    else if (a.kind === "meso") meso += 1;
  }
  const maxStat = Math.max(s.STR, s.DEX, s.INT, s.LUK);
  return { s, hp, crit, cd, drop, meso, maxStat, allSum };
}

function targetSatisfied(t, sums) {
  switch (t.kind) {
    case "stat": return sums.s[t.stat] >= t.min;
    case "allsum": return sums.allSum >= t.min;
    case "hp": return sums.hp >= t.min;
    case "hat": return sums.cd >= t.cd && sums.maxStat >= t.statMin;
    case "glove": return sums.crit >= t.crit && sums.maxStat >= t.statMin;
    case "dm":
      if (t.combo === "drop2") return sums.drop >= 2;
      if (t.combo === "meso2") return sums.meso >= 2;
      if (t.combo === "dropmeso") return sums.drop >= 1 && sums.meso >= 1;
      if (t.combo === "dm3") return sums.drop + sums.meso >= 3;
      return false;
    default: return false;
  }
}

// 활성 타겟 집합에 대한 등급별 롤 통계
// q: 판매 확률/회, rev: 수수료 반영 기대수익(판매 조건부), satisf: 타겟별 단독 충족 확률
function gradeStats(part, level, grade, targets, allstatCount, feeMul) {
  let q = 0, revSum = 0;
  const share = {}, satisf = {}; const cdf = [];
  enumerateRolls(part, level, grade, (p, a1, a2, a3) => {
    const sums = comboSums(a1, a2, a3, allstatCount);
    let best = null;
    for (const t of targets) {
      if (targetSatisfied(t, sums)) {
        satisf[t.id] = (satisf[t.id] || 0) + p;
        if (!best || t.price > best.price) best = t;
      }
    }
    if (best) {
      q += p;
      const rev = best.price * feeMul;
      revSum += p * rev;
      share[best.id] = (share[best.id] || 0) + p;
      cdf.push({ p, rev, tid: best.id });
    }
  });
  cdf.sort((a, b) => b.rev - a.rev);
  let acc = 0;
  const cum = cdf.map((e) => ({ c: (acc += e.p), rev: e.rev, tid: e.tid }));
  return { q, rev: q > 0 ? revSum / q : 0, share, satisf, cum };
}

// ---------- 라운드 해석 엔진 (천장 이월 마르코프) ----------
function buildEngine(cfg) {
  const { part, level, targets, allstatCount, fee, miracle, costs, itemPrice, floorPrice, autoExclude } = cfg;
  const feeMul = 1 - fee / 100;
  const pE = Math.min(1, GRADE_UP.epic * (miracle ? 2 : 1));
  const pL = Math.min(1, GRADE_UP.unique * (miracle ? 2 : 1));
  const Ce = costs.epic, Cu = costs.unique, Cl = costs.legend;

  // 에픽 구간 기대 재설정 횟수 (42스택 도달 시 다음 재설정 확정 → 최대 43회)
  let epicRolls = 0;
  for (let k = 1; k <= PITY.epic + 1; k++) epicRolls += Math.pow(1 - pE, k - 1);
  const reentry = itemPrice + epicRolls * Ce; // 판매 후 재진입 비용

  // 등급별 도달 가능성 판별 (단독 충족 확률 기준)
  const capa = (grade) => {
    const st = gradeStats(part, level, grade, targets, allstatCount, feeMul);
    return targets.filter((t) => (st.satisf[t.id] || 0) > 1e-12);
  };
  const uCap = capa("unique"), lCap = capa("legend");

  // 유니크 판정: 0.97×판매가 > 재진입 비용
  // (천장은 캐릭터 귀속·이월 → 판매 후 새 매물로 같은 상태에 복귀하므로 카운트와 무관)
  const judgeU = {};
  uCap.forEach((t) => (judgeU[t.id] = t.price * feeMul > reentry));

  // 레전드리 판정: 최적 정지 그리디 (깡통 처분가도 후보로 포함)
  // V(S) = 활성 집합 S를 향해 계속 재설정할 때의 기대 순수익
  //  - S에 깡통 포함 → 모든 롤이 판매됨: V = 1회 롤 기대 수익 (추가 비용 없음)
  //  - 미포함 → V = E[수익|판매] − C_leg / q(S)
  const lCands = [...lCap];
  if (floorPrice > 0) lCands.push({ id: "__floor", kind: "floor", price: floorPrice, label: "깡통 처분" });
  lCands.sort((a, b) => b.price - a.price);
  const judgeL = {};
  let accepted = [];
  const contValue = (S) => {
    const real = S.filter((x) => x.kind !== "floor");
    const hasFloor = S.some((x) => x.kind === "floor");
    if (real.length === 0) return hasFloor ? floorPrice * feeMul : -Infinity;
    const st = gradeStats(part, level, "legend", real, allstatCount, feeMul);
    if (hasFloor) return st.q * st.rev + (1 - st.q) * floorPrice * feeMul;
    return st.q > 1e-12 ? st.rev - Cl / st.q : -Infinity;
  };
  if (lCands.length > 0) {
    accepted = [lCands[0]];
    judgeL[lCands[0].id] = true;
    for (let i = 1; i < lCands.length; i++) {
      const t = lCands[i];
      judgeL[t.id] = t.price * feeMul >= contValue(accepted);
      if (judgeL[t.id]) accepted.push(t);
    }
  }

  // 활성 집합 확정
  const activeU = autoExclude ? uCap.filter((t) => judgeU[t.id]) : uCap;
  const activeL = autoExclude ? accepted.filter((x) => x.kind !== "floor") : lCap;
  const floorAccepted = autoExclude
    ? accepted.some((x) => x.kind === "floor")
    : false; // 수동 모드에선 깡통은 폴백 전용

  const uSt = gradeStats(part, level, "unique", activeU, allstatCount, feeMul);
  const lSt = gradeStats(part, level, "legend", activeL, allstatCount, feeMul);

  // 레전드리 국면 3모드
  //  A) 활성 타겟 없음      → 승급 롤에서 깡통가로 즉시 처분
  //  B) 타겟 있음, 깡통 미채택 → 타겟 뜰 때까지 재설정: 추가 롤 (1-q)/q
  //  C) 타겟 있음, 깡통 채택  → 매 롤이 판매 조건: 승급 롤에서 즉시 판매 (타겟 or 깡통가)
  const legMode = activeL.length === 0 ? "A" : floorAccepted ? "C" : "B";
  const legHitFloor = legMode !== "B"; // 깡통가가 수익에 관여하는지
  const legRolls = legMode === "B" ? (1 - lSt.q) / Math.max(lSt.q, 1e-12) : 0;
  const legRev =
    legMode === "A" ? floorPrice * feeMul
    : legMode === "C" ? lSt.q * lSt.rev + (1 - lSt.q) * floorPrice * feeMul
    : lSt.rev;

  // 유니크 국면 후진 재귀 (j = 유→레 천장 스택, 0~107 · 107스택이면 다음 재설정 확정)
  const N = PITY.unique + 1; // 108개 상태
  const Fc = new Float64Array(N), Fr = new Float64Array(N), Fn = new Float64Array(N);
  const Fd = Array.from({ length: N }, () => new Float64Array(N));
  for (let j = N - 1; j >= 0; j--) {
    const up = j === N - 1 ? 1 : pL;
    const fail = 1 - up;
    Fc[j] = Cu + up * legRolls * Cl;
    Fn[j] = 1 + up * legRolls;
    Fr[j] = up * legRev;
    Fd[j][0] += up;
    if (fail > 0) {
      const saleP = fail * uSt.q, contP = fail * (1 - uSt.q);
      Fr[j] += saleP * uSt.rev;
      Fd[j][Math.min(j + 1, N - 1)] += saleP;
      if (contP > 0 && j + 1 < N) {
        Fc[j] += contP * Fc[j + 1]; Fr[j] += contP * Fr[j + 1]; Fn[j] += contP * Fn[j + 1];
        const nx = Fd[j + 1];
        for (let k = 0; k < N; k++) Fd[j][k] += contP * nx[k];
      }
    }
  }
  // 라운드(j0): 에픽 구간 + 유니크 진입 롤 + 체인
  const round = (j0) => {
    const c = epicRolls * Ce + (1 - uSt.q) * Fc[j0];
    const r = uSt.q * uSt.rev + (1 - uSt.q) * Fr[j0];
    const n = epicRolls + (1 - uSt.q) * Fn[j0];
    return { cost: c, rev: r, resets: n, profit: r - c - itemPrice };
  };
  const roundDist = (j0) => {
    const d = new Float64Array(N);
    d[j0] += uSt.q;
    for (let k = 0; k < N; k++) d[k] += (1 - uSt.q) * Fd[j0][k];
    return d;
  };

  // 정상 분포 π (천장 이월의 장기 평형)
  let pi = new Float64Array(N); pi[0] = 1;
  for (let it = 0; it < 300; it++) {
    const nx = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      if (pi[j] < 1e-14) continue;
      const d = roundDist(j);
      for (let k = 0; k < N; k++) nx[k] += pi[j] * d[k];
    }
    pi = nx;
  }
  let sRev = 0, sCost = 0, sResets = 0;
  for (let j = 0; j < N; j++) {
    if (pi[j] < 1e-14) continue;
    const r = round(j);
    sRev += pi[j] * r.rev; sCost += pi[j] * r.cost; sResets += pi[j] * r.resets;
  }
  return {
    pE, pL, epicRolls, reentry, feeMul,
    uCap, lCap, judgeU, judgeL, activeU, activeL, legMode, legHitFloor,
    uSt, lSt, round, roundDist,
    steady: { rev: sRev, cost: sCost, resets: sResets, profit: sRev - sCost - itemPrice },
    breakeven: sRev - sCost,
  };
}

// ---------- 몬테카를로 (분포·구성비) ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function runMC(eng, cfg, startJ, rounds) {
  const { costs, itemPrice, floorPrice } = cfg;
  const rnd = mulberry32(20260721);
  const sample = (cum, fallback) => {
    if (!cum.length) return { rev: fallback, tid: "__floor" };
    const r = rnd() * cum[cum.length - 1].c;
    for (const e of cum) if (r <= e.c) return e;
    return cum[cum.length - 1];
  };
  const profits = []; const tidCount = {}; let totResets = 0;
  let j = startJ;
  for (let i = 0; i < rounds; i++) {
    let cost = itemPrice, resets = 0, rev = 0, tid = null;
    for (let k = 1; k <= PITY.epic + 1; k++) { resets++; cost += costs.epic; if (k === PITY.epic + 1 || rnd() < eng.pE) break; }
    let done = false;
    if (rnd() < eng.uSt.q) { const s = sample(eng.uSt.cum, 0); rev = s.rev; tid = s.tid; done = true; }
    while (!done) {
      const up = j >= PITY.unique ? true : rnd() < eng.pL;
      resets++; cost += costs.unique;
      if (up) {
        j = 0;
        if (eng.legMode === "A") { rev = floorPrice * eng.feeMul; tid = "__floor"; }
        else if (eng.legMode === "C") {
          // 매 롤이 판매 조건: 승급 롤에서 타겟 or 깡통가로 즉시 판매
          if (rnd() < eng.lSt.q) { const s = sample(eng.lSt.cum, 0); rev = s.rev; tid = s.tid; }
          else { rev = floorPrice * eng.feeMul; tid = "__floor"; }
        } else {
          if (rnd() >= eng.lSt.q) { do { resets++; cost += costs.legend; } while (rnd() >= eng.lSt.q); }
          const s = sample(eng.lSt.cum, floorPrice * eng.feeMul); rev = s.rev; tid = s.tid;
        }
        done = true;
      } else {
        j++;
        if (rnd() < eng.uSt.q) { const s = sample(eng.uSt.cum, 0); rev = s.rev; tid = s.tid; done = true; }
      }
    }
    profits.push(rev - cost);
    tidCount[tid] = (tidCount[tid] || 0) + 1;
    totResets += resets;
  }
  profits.sort((a, b) => a - b);
  const pct = (p) => profits[Math.min(profits.length - 1, Math.floor(p * profits.length))];
  return { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), tidCount, rounds, avgResets: totResets / rounds };
}

// ---------- 포맷 ----------
const fmtMeso = (n) => {
  if (!isFinite(n)) return "—";
  const neg = n < 0; const a = Math.abs(n);
  let s;
  if (a >= 1e8) s = (a / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "억";
  else if (a >= 1e4) s = Math.round(a / 1e4).toLocaleString("ko-KR") + "만";
  else s = Math.round(a).toLocaleString("ko-KR");
  return (neg ? "-" : "") + s;
};
const fmtPct = (p) => (p * 100 < 0.01 && p > 0 ? "<0.01%" : (p * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "%");

// ---------- UI ----------
const C = {
  bg: "#12151b", panel: "#1a1f27", panel2: "#20262f", border: "#2c3440",
  text: "#e8e6df", sub: "#9aa3ad", accent: "#ff9d4d",
  epic: "#b07df7", unique: "#f2c744", legend: "#79e07d", danger: "#f27a6a", ok: "#79e07d",
};
const inputStyle = {
  background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text,
  padding: "6px 8px", fontSize: 13, width: "100%", boxSizing: "border-box", fontFamily: "inherit",
};
const Num = ({ value, onChange, w = 72, ph = "" }) => (
  <input type="number" value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)}
    style={{ ...inputStyle, width: w, textAlign: "center" }} step="any" />
);
const Toggle = ({ on, set, label, color = C.accent }) => (
  <button onClick={() => set(!on)} style={{
    display: "flex", alignItems: "center", gap: 8, background: "none", border: "none",
    cursor: "pointer", color: C.text, fontSize: 13, padding: 0, fontFamily: "inherit" }}>
    <span style={{
      width: 34, height: 19, borderRadius: 10, background: on ? color : "#3a4250",
      position: "relative", transition: "background .15s", flexShrink: 0 }}>
      <span style={{
        position: "absolute", top: 2, left: on ? 17 : 2, width: 15, height: 15,
        borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
    </span>
    {label}
  </button>
);
const Badge = ({ kind, children }) => (
  <span style={{
    fontSize: 11, padding: "2px 8px", borderRadius: 999, fontWeight: 600,
    background: kind === "sell" ? "rgba(121,224,125,.15)" : kind === "hold" ? "rgba(242,122,106,.15)" : "rgba(154,163,173,.15)",
    color: kind === "sell" ? C.ok : kind === "hold" ? C.danger : C.sub }}>{children}</span>
);

export default function App() {
  const [level, setLevel] = useState(200);
  const [part, setPart] = useState("acc");
  const [itemPriceEok, setItemPriceEok] = useState("3");
  const [fee, setFee] = useState("3");
  const [pity, setPity] = useState("0");
  const [floorEok, setFloorEok] = useState("1.5");
  const [miracle, setMiracle] = useState(false);
  const [autoExclude, setAutoExclude] = useState(true);
  const [allstatCount, setAllstatCount] = useState(true);
  const [costs, setCosts] = useState({ ...COST_DEFAULT[200] });
  const [statPrices, setStatPrices] = useState({});
  const [hatRows, setHatRows] = useState([{ cd: 2, statMin: 12, price: "" }, { cd: 3, statMin: 0, price: "" }, { cd: 4, statMin: 0, price: "" }]);
  const [gloveRows, setGloveRows] = useState([{ crit: 8, statMin: 12, price: "" }, { crit: 16, statMin: 0, price: "" }, { crit: 24, statMin: 0, price: "" }]);
  const [accPrices, setAccPrices] = useState({ drop2: "", meso2: "", dropmeso: "", dm3: "" });

  useEffect(() => { setCosts({ ...COST_DEFAULT[level] }); }, [level]);

  const [resetArm, setResetArm] = useState(false);
  useEffect(() => {
    if (!resetArm) return;
    const t = setTimeout(() => setResetArm(false), 3000);
    return () => clearTimeout(t);
  }, [resetArm]);
  const clearAllPrices = () => {
    if (!resetArm) { setResetArm(true); return; }
    setStatPrices({});
    setAccPrices({ drop2: "", meso2: "", dropmeso: "", dm3: "" });
    setHatRows((rows) => rows.map((r) => ({ ...r, price: "" })));
    setGloveRows((rows) => rows.map((r) => ({ ...r, price: "" })));
    setResetArm(false);
  };

  const thresholds = useMemo(() => (level === 250 ? [23, 26, 30, 33, 36, 39] : [21, 24, 27, 30, 33, 36]), [level]);
  const allThresholds = useMemo(() => (level === 250 ? [18, 21, 24, 27, 30] : [18, 21, 24, 27]), [level]);
  const statMinOpts = level === 250 ? [0, 7, 10, 13, 17, 20, 23, 26] : [0, 6, 9, 12, 18, 21];

  // 타겟 목록 구성
  const targets = useMemo(() => {
    const list = [];
    const num = (v) => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n * 1e8 : null; };
    if (part !== "glove") {
      for (const st of [...STATS, "HP"])
        for (const th of thresholds) {
          const p = num(statPrices[`${st}_${th}`]);
          if (p) list.push({
            id: `${st}_${th}`, kind: st === "HP" ? "hp" : "stat", stat: st, min: th, price: p,
            label: `${st === "HP" ? "MaxHP" : st} ${th}%↑`,
          });
        }
      for (const th of allThresholds) {
        const p = num(statPrices[`ALL_${th}`]);
        if (p) list.push({ id: `ALL_${th}`, kind: "allsum", min: th, price: p, label: `올스탯 ${th}%↑` });
      }
    }
    if (part === "hat") hatRows.forEach((r, i) => {
      const p = num(r.price);
      if (p) list.push({ id: `hat_${i}`, kind: "hat", cd: r.cd, statMin: r.statMin, price: p,
        label: `쿨감 ${r.cd}초↑${r.statMin ? ` + 스탯 ${r.statMin}%↑` : ""}` });
    });
    if (part === "glove") gloveRows.forEach((r, i) => {
      const p = num(r.price);
      if (p) list.push({ id: `glove_${i}`, kind: "glove", crit: r.crit, statMin: r.statMin, price: p,
        label: `크뎀 ${r.crit}%↑${r.statMin ? ` + 스탯 ${r.statMin}%↑` : ""}` });
    });
    if (part === "acc") {
      const labels = { drop2: "드랍 2줄↑", meso2: "메획 2줄↑", dropmeso: "드랍+메획 각 1줄↑", dm3: "드메 합 3줄" };
      for (const k of Object.keys(labels)) {
        const p = num(accPrices[k]);
        if (p) list.push({ id: `dm_${k}`, kind: "dm", combo: k, price: p, label: labels[k] });
      }
    }
    return list;
  }, [part, thresholds, allThresholds, statPrices, hatRows, gloveRows, accPrices]);

  const cfgInput = useMemo(() => ({
    targets, part, level, allstatCount, miracle, autoExclude, fee, costs, itemPriceEok, floorEok, pity,
  }), [targets, part, level, allstatCount, miracle, autoExclude, fee, costs, itemPriceEok, floorEok, pity]);
  const dcfg = useDeferredValue(cfgInput);

  const result = useMemo(() => {
    if (dcfg.targets.length === 0) return null;
    try {
      const cfg = {
        part: dcfg.part, level: dcfg.level, targets: dcfg.targets,
        allstatCount: dcfg.allstatCount, miracle: dcfg.miracle, autoExclude: dcfg.autoExclude,
        fee: parseFloat(dcfg.fee) || 0,
        costs: { epic: +dcfg.costs.epic || 0, unique: +dcfg.costs.unique || 0, legend: +dcfg.costs.legend || 0 },
        itemPrice: (parseFloat(dcfg.itemPriceEok) || 0) * 1e8,
        floorPrice: (parseFloat(dcfg.floorEok) || 0) * 1e8,
      };
      const eng = buildEngine(cfg);
      const j0 = Math.max(0, Math.min(PITY.unique, parseInt(dcfg.pity) || 0));
      const first = eng.round(j0);
      const estRounds = Math.max(2000, Math.min(15000, Math.floor(1.5e6 / Math.max(20, eng.steady.resets))));
      const mc = runMC(eng, cfg, j0, estRounds);
      return { eng, cfg, first, j0, mc };
    } catch (e) { return { error: String(e) }; }
  }, [dcfg]);

  const gradeChip = (label, color, sub) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ color, fontWeight: 700, fontSize: 14 }}>{label}</span>
      <span style={{ color: C.sub, fontSize: 11, whiteSpace: "nowrap" }}>{sub}</span>
    </div>
  );

  const eng = result && !result.error ? result.eng : null;
  const judgedMap = {};
  if (eng) {
    for (const t of targets) {
      const inU = eng.uCap.some((x) => x.id === t.id);
      const inL = eng.lCap.some((x) => x.id === t.id);
      judgedMap[t.id] = {
        u: inU ? !!eng.judgeU[t.id] : null,        // 유니크: 판매(true)/홀드(false)/도달불가(null)
        l: inL ? !!eng.judgeL[t.id] : null,        // 레전드리 판정 (최적 정지)
      };
    }
  }
  const compTotal = result && result.mc ? result.mc.rounds : 0;
  const compEntries = result && result.mc
    ? Object.entries(result.mc.tidCount).sort((a, b) => b[1] - a[1]).map(([tid, n]) => ({
        label: tid === "__floor" ? "레전 깡통 처분" : (targets.find((t) => t.id === tid) || {}).label || tid,
        share: n / compTotal,
      }))
    : [];

  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.text, padding: "20px 16px",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif" }}>
      <style>{`
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; appearance: textfield; }
      `}</style>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        {/* 헤더 */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>
              잠재능력 재설정 <span style={{ color: C.accent }}>장사 계산기</span>
            </h1>
            <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 12 }}>
              에픽 시작 → 종료조건 도달 시 판매 · 유→레 천장 이월 반영 · 공식 확률표 기반 정확 열거 계산
            </p>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 16px" }}>
            {gradeChip("에픽", C.epic, `${fmtMeso(+costs.epic)}/회`)}
            <span style={{ color: C.sub, fontSize: 12 }}>{miracle ? "7%" : "3.5%"} · 천장42 →</span>
            {gradeChip("유니크", C.unique, `${fmtMeso(+costs.unique)}/회`)}
            <span style={{ color: C.sub, fontSize: 12 }}>{miracle ? "2.8%" : "1.4%"} · 천장107 →</span>
            {gradeChip("레전드리", C.legend, `${fmtMeso(+costs.legend)}/회`)}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          {/* 좌측: 설정 */}
          <div style={{ flex: "0 1 280px", minWidth: 260, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em" }}>장비 설정</div>
              <label style={{ fontSize: 12, color: C.sub }}>노작 매입가 (억 메소)
                <Num value={itemPriceEok} onChange={setItemPriceEok} w="100%" /></label>
              <label style={{ fontSize: 12, color: C.sub }}>레벨 제한
                <select value={level} onChange={(e) => setLevel(+e.target.value)} style={inputStyle}>
                  {[140, 160, 200, 250].map((l) => <option key={l} value={l}>{l}제</option>)}
                </select></label>
              <label style={{ fontSize: 12, color: C.sub }}>착용 부위
                <select value={part} onChange={(e) => setPart(e.target.value)} style={inputStyle}>
                  {Object.entries(PART_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></label>
              <label style={{ fontSize: 12, color: C.sub }}>현재 유→레 천장 스택 (0~107)
                <Num value={pity} onChange={setPity} w="100%" /></label>
              <label style={{ fontSize: 12, color: C.sub }}>경매장 수수료 (%)
                <Num value={fee} onChange={setFee} w="100%" /></label>
              <label style={{ fontSize: 12, color: C.sub }}>레전 깡통·잡옵 처분가 (억, 폴백용)
                <Num value={floorEok} onChange={setFloorEok} w="100%" /></label>
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              <Toggle on={miracle} set={setMiracle} label="미라클데이 (등급업 확률 ×2)" color="#f2c744" />
              <Toggle on={autoExclude} set={setAutoExclude} label="홀드 판정 타겟 자동 제외 (최적 정책)" />
              <Toggle on={allstatCount} set={setAllstatCount} label="올스탯 줄을 스탯 합산에 포함" />
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em" }}>재설정 비용 (메소, 수정 가능)</div>
              {[["epic", "에픽", C.epic], ["unique", "유니크", C.unique], ["legend", "레전드리", C.legend]].map(([k, lb, col]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12, color: col, fontWeight: 600 }}>{lb}</span>
                  <input type="number" value={costs[k]} onChange={(e) => setCosts({ ...costs, [k]: e.target.value })}
                    style={{ ...inputStyle, width: 130, textAlign: "right" }} />
                </div>
              ))}
              <div style={{ fontSize: 11, color: C.sub }}>기본값: 2024.01 공식 표 ({level}제 구간)</div>
            </div>
          </div>

          {/* 우측: 판매가 입력 */}
          <div style={{ flex: "1 1 480px", minWidth: 320, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: C.sub }}>
                판매가 입력값은 레벨·부위를 바꿔도 유지돼요 (레벨별 기준치 칸에 각각 저장)
              </span>
              <button onClick={clearAllPrices} style={{
                background: resetArm ? "rgba(242,122,106,.15)" : C.panel,
                border: `1px solid ${resetArm ? C.danger : C.border}`,
                color: resetArm ? C.danger : C.sub, borderRadius: 8, padding: "6px 12px",
                fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
                fontWeight: resetArm ? 700 : 400, transition: "all .15s" }}>
                {resetArm ? "한 번 더 누르면 전체 삭제" : "입력한 판매가 일괄 초기화"}
              </button>
            </div>
            {part !== "glove" && (
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em", marginBottom: 8 }}>
                  판매가 — 스탯 합계 (억 메소 · 빈칸 = 종료조건 제외)
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                    <thead><tr>
                      <th style={{ textAlign: "left", color: C.sub, padding: 4 }}></th>
                      {thresholds.map((t) => <th key={t} style={{ color: C.sub, fontWeight: 600, padding: 4 }}>{t}%↑</th>)}
                    </tr></thead>
                    <tbody>
                      {[...STATS, "HP"].map((st) => (
                        <tr key={st}>
                          <td style={{ padding: 4, color: st === "HP" ? "#e58fb1" : C.text, fontWeight: 600 }}>{st === "HP" ? "MaxHP" : st}</td>
                          {thresholds.map((th) => (
                            <td key={th} style={{ padding: 2, textAlign: "center" }}>
                              <Num w={62} value={statPrices[`${st}_${th}`] ?? ""} ph="—"
                                onChange={(v) => setStatPrices((s) => ({ ...s, [`${st}_${th}`]: v }))} />
                            </td>
                          ))}
                        </tr>
                      ))}
                      <tr style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: "8px 4px 4px", color: "#8fd3e5", fontWeight: 600, whiteSpace: "nowrap" }}>올스탯</td>
                        {thresholds.map((_, i) => (
                          <td key={i} style={{ padding: "6px 2px 2px", verticalAlign: "bottom" }}>
                            {i < allThresholds.length ? (
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                <span style={{ fontSize: 10, color: "#8fd3e5" }}>{allThresholds[i]}%↑</span>
                                <Num w={62} value={statPrices[`ALL_${allThresholds[i]}`] ?? ""} ph="—"
                                  onChange={(v) => setStatPrices((s) => ({ ...s, [`ALL_${allThresholds[i]}`]: v }))} />
                              </div>
                            ) : null}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>
                  합계 ≥ 기준이면 판매(가장 높은 기준의 가격 적용) · MaxHP엔 올스탯 미합산 ·
                  올스탯 행은 올스탯% 줄만의 합계(제논용, 단일 스탯 줄 미포함)이라 기준치가 달라요
                </div>
              </div>
            )}
            {(part === "hat" || part === "glove") && (
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em", marginBottom: 8 }}>
                  {part === "hat" ? "모자 특수 잠재 (쿨감, 레전드리 전용)" : "장갑 특수 잠재 (크뎀, 레전드리 전용)"}
                </div>
                {(part === "hat" ? hatRows : gloveRows).map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                    {part === "hat" ? (
                      <select value={r.cd} onChange={(e) => setHatRows(hatRows.map((x, k) => k === i ? { ...x, cd: +e.target.value } : x))} style={{ ...inputStyle, width: 110 }}>
                        {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>쿨감 {n}초↑</option>)}
                      </select>
                    ) : (
                      <select value={r.crit} onChange={(e) => setGloveRows(gloveRows.map((x, k) => k === i ? { ...x, crit: +e.target.value } : x))} style={{ ...inputStyle, width: 110 }}>
                        {[8, 16, 24].map((n) => <option key={n} value={n}>크뎀 {n}%↑</option>)}
                      </select>
                    )}
                    <select value={r.statMin}
                      onChange={(e) => (part === "hat" ? setHatRows(hatRows.map((x, k) => k === i ? { ...x, statMin: +e.target.value } : x))
                        : setGloveRows(gloveRows.map((x, k) => k === i ? { ...x, statMin: +e.target.value } : x)))}
                      style={{ ...inputStyle, width: 130 }}>
                      {statMinOpts.map((m) => <option key={m} value={m}>{m === 0 ? "스탯 무관" : `+ 스탯 ${m}%↑`}</option>)}
                    </select>
                    <Num w={80} value={r.price} ph="가격(억)"
                      onChange={(v) => (part === "hat" ? setHatRows(hatRows.map((x, k) => k === i ? { ...x, price: v } : x))
                        : setGloveRows(gloveRows.map((x, k) => k === i ? { ...x, price: v } : x)))} />
                    <button onClick={() => (part === "hat" ? setHatRows(hatRows.filter((_, k) => k !== i)) : setGloveRows(gloveRows.filter((_, k) => k !== i)))}
                      style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 14 }}>✕</button>
                  </div>
                ))}
                <button onClick={() => (part === "hat" ? setHatRows([...hatRows, { cd: 2, statMin: 0, price: "" }]) : setGloveRows([...gloveRows, { crit: 8, statMin: 0, price: "" }]))}
                  style={{ ...inputStyle, width: "auto", cursor: "pointer", color: C.accent }}>+ 조합 추가</button>
              </div>
            )}
            {part === "acc" && (
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em", marginBottom: 8 }}>
                  장신구 드메 잠재 (레전드리 전용, 줄당 20%)
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {[["drop2", "드랍 2줄↑"], ["meso2", "메획 2줄↑"], ["dropmeso", "드랍+메획 각1줄↑"], ["dm3", "드메 합 3줄"]].map(([k, lb]) => (
                    <label key={k} style={{ fontSize: 12, color: C.sub }}>{lb}
                      <Num w={90} value={accPrices[k]} ph="가격(억)" onChange={(v) => setAccPrices({ ...accPrices, [k]: v })} />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* 결과 */}
            {!result && (
              <div style={{ background: C.panel, border: `1px dashed ${C.border}`, borderRadius: 10, padding: 24, textAlign: "center", color: C.sub, fontSize: 13 }}>
                판매가를 1개 이상 입력하면 계산이 시작됩니다
              </div>
            )}
            {result && result.error && (
              <div style={{ background: C.panel, border: `1px solid ${C.danger}`, borderRadius: 10, padding: 16, color: C.danger, fontSize: 12 }}>
                계산 오류: {result.error}
              </div>
            )}
            {eng && (
              <>
                {eng.legMode === "A" && (
                  <div style={{ background: "rgba(242,199,68,.08)", border: `1px solid rgba(242,199,68,.4)`, borderRadius: 10, padding: "10px 14px", fontSize: 12, color: C.unique }}>
                    활성 레전드리 종료조건이 없어, 레전드리 도달 시 깡통 처분가({fmtMeso((parseFloat(floorEok) || 0) * 1e8)})로 즉시 판매한다고 가정했어요.
                  </div>
                )}
                {eng.legMode === "C" && (
                  <div style={{ background: "rgba(121,224,125,.08)", border: `1px solid rgba(121,224,125,.35)`, borderRadius: 10, padding: "10px 14px", fontSize: 12, color: C.legend }}>
                    깡통 처분가({fmtMeso((parseFloat(floorEok) || 0) * 1e8)})가 재설정 지속보다 이득이라, 레전드리 도달 즉시 판매(타겟 뜨면 타겟가)하는 정책으로 계산했어요.
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                  {[
                    ["재설정 1회당 기대 이득", eng.steady.profit / eng.steady.resets, true],
                    ["라운드당 기대 순익 (장기)", eng.steady.profit, true],
                    ["라운드당 기대 재설정", eng.steady.resets, false],
                    ["손익분기 노작 매입가", eng.breakeven, null],
                  ].map(([lb, v, money]) => (
                    <div key={lb} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px" }}>
                      <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>{lb}</div>
                      <div style={{ fontSize: 19, fontWeight: 800, color: money === true ? (v >= 0 ? C.ok : C.danger) : C.text }}>
                        {money === false ? v.toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "회"
                          : (money === true && v >= 0 ? "+" : "") + fmtMeso(v)}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px", fontSize: 12, color: C.sub }}>
                  현재 천장 {result.j0}회 기준 첫 라운드: 순익 <b style={{ color: result.first.profit >= 0 ? C.ok : C.danger }}>
                  {(result.first.profit >= 0 ? "+" : "") + fmtMeso(result.first.profit)}</b> · 재설정 {result.first.resets.toFixed(1)}회 ·
                  투입 {fmtMeso(result.first.cost)} · 재진입 비용(매입가+에픽 {eng.epicRolls.toFixed(1)}회): {fmtMeso(eng.reentry)}
                </div>

                {/* 타겟 판정 */}
                <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em", marginBottom: 8 }}>타겟별 판매/홀드 판정</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead><tr style={{ color: C.sub }}>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>타겟</th>
                      <th style={{ textAlign: "right", padding: "4px 6px" }}>판매가</th>
                      <th style={{ textAlign: "center", padding: "4px 6px" }}>유니크에서</th>
                      <th style={{ textAlign: "center", padding: "4px 6px" }}>레전드리에서</th>
                    </tr></thead>
                    <tbody>
                      {targets.map((t) => {
                        const j = judgedMap[t.id] || {};
                        return (
                          <tr key={t.id} style={{ borderTop: `1px solid ${C.border}` }}>
                            <td style={{ padding: "6px" }}>{t.label}</td>
                            <td style={{ padding: "6px", textAlign: "right", color: C.sub }}>{fmtMeso(t.price)}</td>
                            <td style={{ padding: "6px", textAlign: "center" }}>
                              {j.u === null || j.u === undefined ? <Badge kind="na">도달 불가</Badge>
                                : j.u ? <Badge kind="sell">판매</Badge> : <Badge kind="hold">홀드 · 재설정 이득</Badge>}
                            </td>
                            <td style={{ padding: "6px", textAlign: "center" }}>
                              {j.l === null || j.l === undefined ? <Badge kind="na">도달 불가</Badge>
                                : j.l ? <Badge kind="sell">판매</Badge> : <Badge kind="hold">홀드 · 상위 노리기</Badge>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 8 }}>
                    유니크 판정 기준: 0.97×판매가 &gt; 매입가+에픽구간 비용({fmtMeso(eng.reentry)}) — 천장은 캐릭터 귀속이라 팔아도 이월되므로 카운트와 무관 ·
                    레전드리 판정: 계속 재설정 시 기대 수익과 비교(최적 정지)
                  </div>
                </div>

                {/* 판매 구성 + 리스크 */}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 260px", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em", marginBottom: 8 }}>
                      라운드 종료 구성 (시뮬레이션 {result.mc.rounds.toLocaleString()}라운드)
                    </div>
                    {compEntries.map((e) => (
                      <div key={e.label} style={{ marginBottom: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                          <span>{e.label}</span><span style={{ color: C.sub }}>{fmtPct(e.share)}</span>
                        </div>
                        <div style={{ height: 5, background: C.panel2, borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${Math.max(1, e.share * 100)}%`, height: "100%", background: C.accent }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ flex: "1 1 220px", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 12, color: C.sub, fontWeight: 700, letterSpacing: ".06em", marginBottom: 8 }}>라운드 순익 분포 (리스크)</div>
                    {[["하위 10% (불운)", result.mc.p10], ["중앙값", result.mc.p50], ["상위 10% (행운)", result.mc.p90]].map(([lb, v]) => (
                      <div key={lb} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
                        <span style={{ color: C.sub }}>{lb}</span>
                        <span style={{ fontWeight: 700, color: v >= 0 ? C.ok : C.danger }}>{(v >= 0 ? "+" : "") + fmtMeso(v)}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 8 }}>
                      기댓값이 +여도 단기 편차가 큽니다. 회전 자금은 하위 10% 기준으로 준비하세요.
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.6 }}>
                  가정: 잠재능력 재설정(블랙큐브 동일 성능) · 에픽잠재부여주문서 비용 0 · 등업 롤은 새 등급 옵션으로 판정 ·
                  쓸만한 스킬(최대 1줄)/피격 무적류(최대 1~2줄) 재계산 규칙 반영 · "동일 결과 재출현 방지"는 무시(오차 미미) ·
                  미라클데이는 등급업 확률만 ×2 (천장 적립·옵션 확률 불변)
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
