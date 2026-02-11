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

  // EarningsV2 ABI (เฉพาะที่ owner panel ใช้)
  const EARNINGS_ABI = [
    "function core() view returns (address)",
    "function owner() view returns (address)",
    "function users(address) view returns (uint8 rank,bool active,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function ownerGrantRank(address u,uint8 r,bool active_)"
  ];

  let provider, signer, me, earnings;

  async function ensureBSC() {
    const net = await provider.getNetwork();
    $("net").textContent = `chainId: ${net.chainId}`;
    if (Number(net.chainId) === Number(C.CHAIN_ID_DEC)) return true;
    toast("กรุณาเปลี่ยนเป็น BNB Chain (chainId 56)", false);
    return false;
  }

  function showErr(e, prefix="ERROR") {
    console.error(prefix, e);
    const msg =
      e?.shortMessage ||
      e?.reason ||
      e?.message ||
      String(e);
    toast(`${prefix}: ${msg}`, false);
  }

  async function connect() {
    if (!window.ethereum) return toast("ไม่พบ Wallet", false);

    provider = new ethers.BrowserProvider(window.ethereum);

    // ขอ account ก่อน เพื่อให้ signer พร้อมจริง (กันอาการนิ่งในบางกระเป๋า)
    await provider.send("eth_requestAccounts", []);
    if (!(await ensureBSC())) return;

    signer = await provider.getSigner();
    me = await signer.getAddress();

    $("wallet").textContent = short(me);
    $("walletScan").href = toScan(me);

    $("coreAddr").textContent = C.CORE;
    $("earnAddr").textContent = C.EARNINGS;

    // สำคัญ: ต้องผูก signer (ไม่ใช่ provider)
    earnings = new ethers.Contract(C.EARNINGS, EARNINGS_ABI, signer);

    await refreshStatic();

    window.ethereum.on?.("accountsChanged", () => window.location.reload());
    window.ethereum.on?.("chainChanged", () => window.location.reload());

    toast("เชื่อมต่อแล้ว");
  }

  async function refreshStatic() {
    try {
      const ec = await earnings.core();
      const eo = await earnings.owner();

      $("earnCore").textContent = ec;
      $("earnOwner").textContent = eo;

      const isOwner = eo && me && eo.toLowerCase() === me.toLowerCase();
      $("isOwner").textContent = `owner?: ${isOwner ? "YES" : "NO"}`;
      if (!isOwner) toast("เตือน: กระเป๋านี้ไม่ใช่ owner ของ EarningsV2 (จะ Offer ไม่ได้)", false);
    } catch (e) {
      showErr(e, "อ่านค่า earnings.core/owner ไม่ได้");
    }
  }

  async function checkUser() {
    if (!earnings) return toast("ยังไม่เชื่อมต่อ", false);
    try {
      const u = ($("target").value || "").trim();
      if (!ethers.isAddress(u)) return toast("Target ไม่ถูกต้อง", false);

      const r = await earnings.users(u);
      const rank = Number(r.rank ?? r[0]);
      const active = Boolean(r.active ?? r[1]);

      const paidTotal = r.paidTotal ?? r[2];
      const accruedRef = r.accruedRef ?? r[3];
      const accruedMatch = r.accruedMatch ?? r[4];
      const claimedTotal = r.claimedTotal ?? r[5];

      $("preview").textContent =
        `users(${u})\n` +
        `rank: ${rank}  active: ${active}\n` +
        `paidTotal: ${paidTotal}\naccruedRef: ${accruedRef}\naccruedMatch: ${accruedMatch}\nclaimedTotal: ${claimedTotal}`;

      toast("อ่าน users(u) สำเร็จ");
    } catch (e) {
      showErr(e, "Check Available ล้มเหลว");
    }
  }

  async function offer() {
    if (!earnings) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC())) return;

    const u = ($("target").value || "").trim();
    if (!ethers.isAddress(u)) return toast("Target ไม่ถูกต้อง", false);

    const r = Number($("rank").value || 0);
    const active = String($("active").value) === "true";

    try {
      $("btnOffer").disabled = true;

      // ส่ง tx จริง
      const tx = await earnings.ownerGrantRank(u, r, active);
      toast("ส่งธุรกรรม Offer แล้ว");
      const rc = await tx.wait();
      toast("Offer สำเร็จ ✅");

      console.log("tx:", toTx(rc.hash));
      await checkUser();
    } catch (e) {
      showErr(e, "Offer ล้มเหลว");
    } finally {
      $("btnOffer").disabled = false;
    }
  }

  $("btnConnect").addEventListener("click", connect);
  $("btnCheck").addEventListener("click", checkUser);
  $("btnOffer").addEventListener("click", offer);
})();
