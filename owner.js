(() => {
  "use strict";
  const C = window.APP_CONFIG;

  const $ = (id) => document.getElementById(id);
  const toastEl = $("toast");
  function toast(msg, ok = true) {
    if (!toastEl) return alert(msg);
    toastEl.textContent = msg;
    toastEl.style.borderColor = ok ? "rgba(54,211,153,.35)" : "rgba(255,77,77,.35)";
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "-");
  const toScan = (addr) => `${C.BLOCK_EXPLORER}/address/${addr}`;
  const toTx = (h) => `${C.BLOCK_EXPLORER}/tx/${h}`;
  const isAddr = (a) => { try { return ethers.isAddress(a); } catch { return false; } };

  function parseBool(s) {
    const t = String(s || "").trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
    throw new Error("bool invalid");
  }

  function toWei18(v) { return ethers.parseUnits(String(v || "0"), 18); }

  async function ensureBSC() {
    try {
      const net = await provider.getNetwork();
      if (Number(net.chainId) === C.CHAIN_ID_DEC) return true;
    } catch {}
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: C.CHAIN_ID_HEX }],
      });
      return true;
    } catch (e) {
      toast("กรุณาเปลี่ยนเป็น BNB Chain (chainId 56)", false);
      return false;
    }
  }

  // ====== ABIs ======
  const CORE_ABI = [
    "function owner() view returns (address)",
    "function defaultSponsor() view returns (address)",
    "function setDefaultSponsor(address s)",
    "function treasury() view returns (address)",
    "function setTreasury(address t)",
    "function setPackage(uint256 id,bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 apyBP,uint256 lockSeconds,uint8 rank)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 apyBP,uint256 lockSeconds,uint8 rank)"
  ];

  // ✅ Earnings ABI (จากที่คุณส่ง) — เอาเฉพาะส่วนที่ Owner ใช้ + claim/read ที่จำเป็น
  const EARNINGS_ABI = [
    "function owner() view returns (address)",
    "function core() view returns (address)",
    "function referral() view returns (address)",
    "function reserve() view returns (address)",
    "function bufferBP() view returns (uint16)",
    "function setBufferBP(uint16 bp)",
    "function setCaps(uint256 b,uint256 s,uint256 g)",
    "function setCore(address c)",
    "function setReferral(address r)",
    "function setReserve(address r)",
    "function setRates(uint16[3] bronze_,uint16[3] silver_,uint16[3] gold_,uint16[3] match_)",

    // ✅ offer
    "function ownerGrantRank(address u,uint8 r,bool active_)",
    "function setRank(address u,uint8 r)",

    // user view
    "function users(address) view returns (uint8 rank,bool active,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function remainingCap(address u) view returns (uint256)",
    "function capMax(address u) view returns (uint256)",
    "function withdrawableEarnings(address u) view returns (uint256)",

    // constants / caps
    "function CAP_BRONZE() view returns (uint256)",
    "function CAP_SILVER() view returns (uint256)",
    "function CAP_GOLD() view returns (uint256)",
  ];

  // ====== State ======
  let provider = null, signer = null, me = null;
  let core = null, earn = null;

  // ====== UI helpers (optional fields) ======
  function setText(id, v) { const el = $(id); if (el) el.textContent = v; }
  function setVal(id, v) { const el = $(id); if (el) el.value = v; }

  async function connect() {
    if (!window.ethereum) return toast("ไม่พบ Wallet", false);

    provider = new ethers.BrowserProvider(window.ethereum);
    if (!(await ensureBSC())) return;

    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    me = await signer.getAddress();

    setText("wallet", short(me));
    $("walletScan").href = toScan(me);

    // net pill
    try {
      const net = await provider.getNetwork();
      setText("netPill", `chainId: ${net.chainId}`);
    } catch {}

    // contracts
    core = new ethers.Contract(C.CORE, CORE_ABI, signer);
    earn = new ethers.Contract(C.EARNINGS, EARNINGS_ABI, signer);

    setText("coreText", short(C.CORE));
    $("coreScan").href = toScan(C.CORE);

    // owner check (core + earnings)
    try {
      const o1 = await core.owner();
      const o2 = await earn.owner();
      if (ethers.getAddress(o1) !== ethers.getAddress(me)) toast("เตือน: wallet นี้ไม่ใช่ Owner ของ CoreV4", false);
      if (ethers.getAddress(o2) !== ethers.getAddress(me)) toast("เตือน: wallet นี้ไม่ใช่ Owner ของ Earnings", false);
    } catch {}

    $("btnConnect").disabled = true;

    await readDefaultSponsor();
    await readTreasury();
    await readEarningsAdmin();

    toast("เชื่อมต่อแล้ว ✅");

    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }

  // ===== Core admin =====
  async function readDefaultSponsor() {
    try { setVal("curDefaultSponsor", await core.defaultSponsor()); } catch { setVal("curDefaultSponsor", "-"); }
  }
  async function setDefaultSponsor() {
    const s = ($("newDefaultSponsor").value || "").trim();
    if (!isAddr(s)) return toast("defaultSponsor ไม่ถูกต้อง", false);
    if (!(await ensureBSC())) return;
    try {
      const tx = await core.setDefaultSponsor(s);
      toast("ส่ง setDefaultSponsor แล้ว");
      const rc = await tx.wait();
      toast("ตั้ง DefaultSponsor สำเร็จ");
      console.log("tx:", toTx(rc.hash));
      await readDefaultSponsor();
    } catch (e) { console.error(e); toast("ตั้ง DefaultSponsor ไม่สำเร็จ", false); }
  }

  async function readTreasury() {
    try { setVal("curTreasury", await core.treasury()); } catch { setVal("curTreasury", "-"); }
  }
  async function setTreasury() {
    const t = ($("newTreasury").value || "").trim();
    if (!isAddr(t)) return toast("treasury ไม่ถูกต้อง", false);
    if (!(await ensureBSC())) return;
    try {
      const tx = await core.setTreasury(t);
      toast("ส่ง setTreasury แล้ว");
      const rc = await tx.wait();
      toast("ตั้ง Treasury สำเร็จ");
      console.log("tx:", toTx(rc.hash));
      await readTreasury();
    } catch (e) { console.error(e); toast("ตั้ง Treasury ไม่สำเร็จ", false); }
  }

  async function readPkg() {
    const id = Number(($("pkgId").value || "0").trim());
    try {
      const p = await core.packages(id);
      setVal("pkgActive", String(p.active ?? p[0]));
      setVal("usdtPrice", ethers.formatUnits(p.usdtPrice ?? p[1], 18));
      setVal("thbcAmount", ethers.formatUnits(p.thbcAmount ?? p[2], 18));
      setVal("apyBP", String(p.apyBP ?? p[3]));
      setVal("lockSeconds", String(p.lockSeconds ?? p[4]));
      setVal("rank", String(p.rank ?? p[5]));
      toast(`อ่าน Package #${id} แล้ว ✅`);
    } catch (e) { console.error(e); toast("อ่าน package ไม่ได้", false); }
  }

  async function setPkg() {
    if (!(await ensureBSC())) return;

    try {
      const id = BigInt(Number(($("pkgId").value || "0").trim()));
      const active = parseBool($("pkgActive").value);
      const usdtPrice = toWei18($("usdtPrice").value);
      const thbcAmount = toWei18($("thbcAmount").value);
      const apyBP = BigInt(Number(($("apyBP").value || "0").trim())); // 50=0.5% ต่อปี
      const lockSeconds = BigInt(Number(($("lockSeconds").value || "0").trim())); // 365d=31536000
      const rank = Number(($("rank").value || "0").trim()); // 0..3
      if (rank < 0 || rank > 3) return toast("rank ต้อง 0..3", false);

      const tx = await core.setPackage(id, active, usdtPrice, thbcAmount, apyBP, lockSeconds, rank);
      toast("ส่ง setPackage แล้ว");
      const rc = await tx.wait();
      toast("setPackage สำเร็จ ✅");
      console.log("tx:", toTx(rc.hash));
    } catch (e) { console.error(e); toast("setPackage ไม่สำเร็จ", false); }
  }

  // ===== Earnings admin / offer =====
  async function readEarningsAdmin() {
    // โชว์สถานะว่า offer มีแน่นอน
    const st = $("offerStatus");
    if (st) st.textContent = "OK: ownerGrantRank()";

    // (ถ้าใน owner.html ไม่มีช่องเหล่านี้ ก็ไม่เป็นไร)
    try {
      const c = await earn.core();
      const r = await earn.referral();
      const res = await earn.reserve();
      const b = await earn.bufferBP();
      console.log("earnings.core:", c, "referral:", r, "reserve:", res, "bufferBP:", b);
    } catch {}
  }

  async function offerUser() {
    if (!earn) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC())) return;

    const u = ($("targetUser").value || "").trim();
    if (!isAddr(u)) return toast("Target user ไม่ถูกต้อง", false);

    const r = Number(($("offerRank").value || "0").trim());
    if (r < 0 || r > 3) return toast("rank ต้อง 0..3", false);

    let active = true;
    try { active = parseBool($("offerActive").value); } catch { return toast("active ต้อง true/false", false); }

    try {
      const tx = await earn.ownerGrantRank(u, r, active);
      toast("ส่ง ownerGrantRank แล้ว");
      const rc = await tx.wait();
      toast("Offer สำเร็จ ✅");
      console.log("tx:", toTx(rc.hash));
    } catch (e) { console.error(e); toast("Offer ไม่สำเร็จ", false); }
  }

  // ===== bind =====
  function bind() {
    $("btnConnect")?.addEventListener("click", connect);

    $("btnReadDefault")?.addEventListener("click", readDefaultSponsor);
    $("btnSetDefault")?.addEventListener("click", setDefaultSponsor);

    $("btnReadTreasury")?.addEventListener("click", readTreasury);
    $("btnSetTreasury")?.addEventListener("click", setTreasury);

    $("btnReadPkg")?.addEventListener("click", readPkg);
    $("btnSetPkg")?.addEventListener("click", setPkg);

    $("btnOffer")?.addEventListener("click", offerUser);
    $("btnCheckOffer")?.addEventListener("click", readEarningsAdmin);

    // static
    setText("coreText", short(C.CORE));
    $("coreScan") && ($("coreScan").href = toScan(C.CORE));
  }

  bind();
})();
