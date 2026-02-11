(() => {
  "use strict";
  const C = window.APP_CONFIG;

  // ---------- DOM ----------
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

  // ---------- State ----------
  let provider = null;     // BrowserProvider or JsonRpcProvider (readonly)
  let signer = null;
  let user = null;

  let core = null;
  let usdt = null;
  let earnings = null;
  let stake365 = null;

  let readonly = false;

  let refFromUrl = null;
  let sideFromUrl = null; // 0 or 1
  let sponsorLocked = false;

  let countdownTimer = null;
  const countdownMap = new Map();

  // ---------- ABIs ----------
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];

  // CoreV4
  const CORE_ABI = [
    "function packageCount() view returns (uint256)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 apyBP,uint256 lockSeconds,uint8 rank)",
    "function buy(uint256 pkgId,address sponsor,uint8 side)",
    "function defaultSponsor() view returns (address)",
    "function userStakeCount(address u) view returns (uint256)",
    "function userStakeIndexAt(address u,uint256 i) view returns (uint256)"
  ];

  // EarningsV2
  const EARNINGS_ABI = [
    "function users(address) view returns (uint8 rank,bool active,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function withdrawableEarnings(address) view returns (uint256)",
    "function claimReferral(uint256 amount)",
    "function claimMatching(uint256 amount)"
  ];

  // Stake365 (KJCAutoStake365)
  const STAKE365_ABI = [
    "function stakes(address,uint256) view returns (uint256 principal,uint256 dailyBP,uint256 startTs,uint256 endTs,uint256 totalReward,bool claimed)",
    "function claim(uint256 index)"
  ];

  // ---------- Utils ----------
  function isAddr(a) {
    try { return ethers.isAddress(a); } catch { return false; }
  }
  function fmtUnits(x, dec = 18, dp = 4) {
    try {
      const s = ethers.formatUnits(x, dec);
      const [i, f = ""] = s.split(".");
      return f ? `${i}.${f.slice(0, dp)}` : i;
    } catch { return "-"; }
  }
  function rankName(r) {
    if (r === 1) return "Bronze";
    if (r === 2) return "Silver";
    if (r === 3) return "Gold";
    return "None";
  }

  // URL: ?ref=0x..&side=L/R
  function readRefSideFromUrl() {
    try {
      const u = new URL(window.location.href);
      const ref = (u.searchParams.get(C.REF_PARAM || "ref") || "").trim();
      const side = (u.searchParams.get(C.SIDE_PARAM || "side") || "").trim().toUpperCase();
      const refOK = ref && isAddr(ref) ? ethers.getAddress(ref) : null;

      let sideVal = null;
      if (side === "L") sideVal = 0;
      if (side === "R") sideVal = 1;

      return { ref: refOK, side: sideVal };
    } catch {
      return { ref: null, side: null };
    }
  }

  function buildRefLink(addr, side) {
    const u = new URL(window.location.href);
    u.searchParams.set(C.REF_PARAM || "ref", addr);
    u.searchParams.set(C.SIDE_PARAM || "side", side === 1 ? "R" : "L");
    return u.toString();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch { return false; }
    }
  }

  // ---------- Chain / Provider ----------
  async function getChainIdSafe() {
    try {
      const net = await provider.getNetwork();
      return Number(net.chainId);
    } catch {
      try {
        // fallback (บาง wallet แปลกๆ)
        const hex = await window.ethereum.request({ method: "eth_chainId" });
        return Number.parseInt(hex, 16);
      } catch { return -1; }
    }
  }

  async function ensureBSCInteractive() {
    // สำหรับ “ซื้อ/approve/claim” เท่านั้น
    if (!window.ethereum) {
      toast("ไม่พบ Wallet", false);
      return false;
    }
    const chainId = await getChainIdSafe();
    if (chainId === C.CHAIN_ID_DEC) return true;

    // พยายาม switch ให้อัตโนมัติ (ถ้า wallet รองรับ)
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: C.CHAIN_ID_HEX }],
      });
      return true;
    } catch (e) {
      // ถ้ายังไม่มี chain ใน wallet → add
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: C.CHAIN_ID_HEX,
            chainName: C.CHAIN_NAME,
            rpcUrls: [C.RPC_URL],
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            blockExplorerUrls: [C.BLOCK_EXPLORER],
          }],
        });
        return true;
      } catch {
        toast("กรุณาเปลี่ยนเป็น BNB Chain (chainId 56)", false);
        return false;
      }
    }
  }

  function setNetPill(chainId) {
    $("netPill").textContent = `chainId: ${chainId > 0 ? chainId : "-"}`;
  }

  // ---------- Readonly init (ให้หน้าไม่ว่าง ต่อให้ยังไม่ connect) ----------
  async function initReadonly() {
    readonly = true;
    provider = new ethers.JsonRpcProvider(C.RPC_URL);
    setNetPill(C.CHAIN_ID_DEC);

    core = new ethers.Contract(C.CORE, CORE_ABI, provider);
    usdt = new ethers.Contract(C.USDT, ERC20_ABI, provider);
    earnings = new ethers.Contract(C.EARNINGS, EARNINGS_ABI, provider);
    stake365 = new ethers.Contract(C.STAKE365, STAKE365_ABI, provider);

    $("coreText").textContent = short(C.CORE);
    $("coreScan").href = toScan(C.CORE);
    $("btnBsc").href = C.BLOCK_EXPLORER;

    await loadPackages(); // ให้เห็นแพ็คเกจแม้ไม่ connect
    await onPkgChange();
  }

  // ---------- Packages ----------
  async function loadPackages() {
    const sel = $("pkg");
    sel.innerHTML = "";

    let count = 0;
    try { count = Number(await core.packageCount()); }
    catch { toast("อ่าน packageCount ไม่ได้", false); return; }

    let added = 0;
    for (let i = 0; i < count; i++) {
      try {
        const p = await core.packages(i);
        if (!p.active) continue;

        const opt = document.createElement("option");
        opt.value = String(i);

        const price = fmtUnits(p.usdtPrice, 18, 2);
        const rk = rankName(Number(p.rank));
        opt.textContent = `#${i}  ${price} USDT (${rk})`;

        sel.appendChild(opt);
        added++;
      } catch {}
    }

    if (added === 0) {
      const opt = document.createElement("option");
      opt.value = "0";
      opt.textContent = "#0";
      sel.appendChild(opt);
      toast("ไม่พบ package active", false);
    }
  }

  async function onPkgChange() {
    const pkgId = Number($("pkg").value || 0);
    try {
      const p = await core.packages(pkgId);
      $("price").value = fmtUnits(p.usdtPrice, 18, 2);
    } catch {
      $("price").value = "-";
    }
  }

  // ---------- Stakes list ----------
  function startCountdownLoop() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const [, obj] of countdownMap.entries()) {
        const diff = obj.endTs - now;
        if (diff <= 0) obj.el.textContent = "READY";
        else {
          const d = Math.floor(diff / 86400);
          const h = Math.floor((diff % 86400) / 3600);
          const m = Math.floor((diff % 3600) / 60);
          const s = diff % 60;
          obj.el.textContent = `${d}d ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
        }
      }
    }, 1000);
  }

  async function loadStakes() {
    const list = $("stakeList");
    list.innerHTML = "";
    countdownMap.clear();

    if (!user) { $("stakeCount").textContent = "0"; return; }

    let n = 0;
    try { n = Number(await core.userStakeCount(user)); }
    catch { $("stakeCount").textContent = "0"; return; }

    $("stakeCount").textContent = String(n);

    for (let i = 0; i < n; i++) {
      let idx = 0n;
      try { idx = await core.userStakeIndexAt(user, i); } catch { continue; }

      const el = document.createElement("div");
      el.className = "item";

      const top = document.createElement("div");
      top.className = "itemTop";

      const left = document.createElement("div");
      left.innerHTML = `
        <div class="mono"><b>#${i}</b> idx: ${idx}</div>
        <div class="tag mono">${short(user)}</div>
      `;

      const cd = document.createElement("div");
      cd.className = "count mono";
      cd.textContent = "-";

      top.appendChild(left);
      top.appendChild(cd);

      const pills = document.createElement("div");
      pills.className = "pills";

      const p1 = document.createElement("div"); p1.className = "p mono"; p1.textContent = "principal: -";
      const p2 = document.createElement("div"); p2.className = "p mono"; p2.textContent = "apyBP: -";
      const p3 = document.createElement("div"); p3.className = "p mono"; p3.textContent = "end: -";
      pills.appendChild(p1); pills.appendChild(p2); pills.appendChild(p3);

      const actions = document.createElement("div");
      actions.className = "actions";

      const btnClaim = document.createElement("button");
      btnClaim.className = "btn";
      btnClaim.textContent = "Claim Stake";
      btnClaim.disabled = true;

      actions.appendChild(btnClaim);

      el.appendChild(top);
      el.appendChild(pills);
      el.appendChild(actions);
      list.appendChild(el);

      try {
        const s = await stake365.stakes(user, i);
        const principal = s.principal ?? s[0];
        const apyBP = s.dailyBP ?? s[1];
        const endTs = Number(s.endTs ?? s[3]);
        const claimed = Boolean(s.claimed ?? s[5]);

        p1.textContent = `principal: ${fmtUnits(principal, 18, 4)}`;
        p2.textContent = `apyBP: ${Number(apyBP)}`;
        p3.textContent = `end: ${new Date(endTs * 1000).toLocaleString()}`;

        countdownMap.set(String(idx), { endTs, el: cd });

        const now = Math.floor(Date.now() / 1000);
        if (!claimed && now >= endTs) btnClaim.disabled = false;

        btnClaim.addEventListener("click", async () => {
          if (!user) return;
          if (!(await ensureBSCInteractive())) return;
          try {
            btnClaim.disabled = true;
            const tx = await stake365.connect(signer).claim(idx);
            toast("Claim ส่งแล้ว");
            const rc = await tx.wait();
            toast("Claim สำเร็จ");
            console.log("claim tx:", toTx(rc.hash));
            await refreshAll();
          } catch (e) {
            console.error(e);
            toast("Claim ไม่สำเร็จ", false);
            btnClaim.disabled = false;
          }
        });
      } catch {}
    }

    startCountdownLoop();
  }

  // ---------- Refresh ----------
  async function refreshAll() {
    if (!user) return;

    // USDT balance/allowance
    try {
      const bal = await usdt.balanceOf(user);
      $("usdtBal").textContent = fmtUnits(bal, 18, 4);

      const allow = await usdt.allowance(user, C.CORE);
      $("usdtAllow").textContent = fmtUnits(allow, 18, 4);
    } catch {
      $("usdtBal").textContent = "-";
      $("usdtAllow").textContent = "-";
    }

    // earnings status
    let rank = 0, active = false, accruedRef = 0n, accruedMatch = 0n;
    try {
      const u = await earnings.users(user);
      rank = Number(u.rank ?? u[0]);
      active = Boolean(u.active ?? u[1]);
      accruedRef = (u.accruedRef ?? u[3]) ?? 0n;
      accruedMatch = (u.accruedMatch ?? u[4]) ?? 0n;

      $("myRank").textContent = rankName(rank);
      $("myStatus").textContent = active ? "OK_SHARE" : "NEED_BUY";

      $("accRef").textContent = fmtUnits(accruedRef, 18, 4);
      $("accMatch").textContent = fmtUnits(accruedMatch, 18, 4);

      const w = await earnings.withdrawableEarnings(user);
      $("withdrawable").textContent = fmtUnits(w, 18, 4);

      $("btnClaimRef").disabled = accruedRef <= 0n;
      $("btnClaimMatch").disabled = accruedMatch <= 0n;
    } catch (e) {
      console.error(e);
      $("myRank").textContent = "-";
      $("myStatus").textContent = "-";
      $("accRef").textContent = "-";
      $("accMatch").textContent = "-";
      $("withdrawable").textContent = "-";
    }

    // referral links
    const left = buildRefLink(user, 0);
    const right = buildRefLink(user, 1);
    $("myRefLeft").textContent = left;
    $("myRefRight").textContent = right;
    $("btnOpenLeft").href = left;
    $("btnOpenRight").href = right;

    // stakes
    await loadStakes();
  }

  // ---------- Actions ----------
  async function approveUSDT() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSCInteractive())) return;

    const pkgId = Number($("pkg").value || 0);
    let need = 0n;
    try {
      const p = await core.packages(pkgId);
      need = p.usdtPrice;
    } catch { return toast("อ่านราคาแพ็คเกจไม่ได้", false); }

    try {
      $("btnApprove").disabled = true;
      const tx = await usdt.connect(signer).approve(C.CORE, need);
      toast("Approve ส่งแล้ว");
      await tx.wait();
      toast("Approve สำเร็จ");
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Approve ไม่สำเร็จ", false);
    } finally {
      $("btnApprove").disabled = false;
    }
  }

  async function buyPackage() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSCInteractive())) return;

    const pkgId = Number($("pkg").value || 0);

    let sponsor = ($("sponsor").value || "").trim();
    let side = Number($("side").value || 0);

    // lock sponsor/side by URL
    if (sponsorLocked && refFromUrl) sponsor = refFromUrl;
    if (sideFromUrl === 0 || sideFromUrl === 1) side = sideFromUrl;

    if (!sponsor || sponsor === "0x") {
      try {
        const ds = await core.defaultSponsor();
        sponsor = (ds && ds !== ethers.ZeroAddress) ? ds : C.DEFAULT_SPONSOR;
      } catch {
        sponsor = C.DEFAULT_SPONSOR;
      }
    }
    if (!isAddr(sponsor)) return toast("Sponsor ไม่ถูกต้อง", false);

    try {
      $("btnBuy").disabled = true;
      const tx = await core.connect(signer).buy(pkgId, sponsor, side);
      toast("Buy ส่งแล้ว");
      const rc = await tx.wait();
      toast("Buy สำเร็จ");
      console.log("buy tx:", toTx(rc.hash));
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Buy ไม่สำเร็จ", false);
    } finally {
      $("btnBuy").disabled = false;
    }
  }

  async function claimReferral() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSCInteractive())) return;

    try {
      const u = await earnings.users(user);
      const accruedRef = (u.accruedRef ?? u[3]) ?? 0n;
      if (accruedRef <= 0n) return toast("accruedRef = 0", false);

      $("btnClaimRef").disabled = true;
      const tx = await earnings.connect(signer).claimReferral(accruedRef);
      toast("Claim Referral ส่งแล้ว");
      await tx.wait();
      toast("Claim Referral สำเร็จ");
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Claim Referral ไม่สำเร็จ", false);
    } finally {
      $("btnClaimRef").disabled = false;
    }
  }

  async function claimMatching() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSCInteractive())) return;

    try {
      const u = await earnings.users(user);
      const accruedMatch = (u.accruedMatch ?? u[4]) ?? 0n;
      if (accruedMatch <= 0n) return toast("accruedMatch = 0", false);

      $("btnClaimMatch").disabled = true;
      const tx = await earnings.connect(signer).claimMatching(accruedMatch);
      toast("Claim Matching ส่งแล้ว");
      await tx.wait();
      toast("Claim Matching สำเร็จ");
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Claim Matching ไม่สำเร็จ", false);
    } finally {
      $("btnClaimMatch").disabled = false;
    }
  }

  // ---------- Connect ----------
  async function connect() {
    if (!window.ethereum) {
      toast("ไม่พบ Wallet (เปิดใน Bitget/MetaMask/OKX Browser)", false);
      return;
    }

    // ใช้ BrowserProvider (ดีที่สุดสำหรับมือถือ/หลายกระเป๋า)
    provider = new ethers.BrowserProvider(window.ethereum);

    // chain check + auto switch/add
    const ok = await ensureBSCInteractive();
    if (!ok) return;

    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    user = await signer.getAddress();
    readonly = false;

    // set UI
    $("wallet").textContent = short(user);
    $("walletScan").textContent = short(user);
    $("walletScan").href = toScan(user);
    $("btnBsc").href = C.BLOCK_EXPLORER;

    // contracts (signer)
    core = new ethers.Contract(C.CORE, CORE_ABI, signer);
    usdt = new ethers.Contract(C.USDT, ERC20_ABI, signer);
    earnings = new ethers.Contract(C.EARNINGS, EARNINGS_ABI, signer);
    stake365 = new ethers.Contract(C.STAKE365, STAKE365_ABI, signer);

    // top core
    $("coreText").textContent = short(C.CORE);
    $("coreScan").href = toScan(C.CORE);

    const chainId = await getChainIdSafe();
    setNetPill(chainId);

    // read URL ref + side
    const rs = readRefSideFromUrl();
    refFromUrl = rs.ref;
    sideFromUrl = rs.side;

    if (refFromUrl) {
      $("sponsor").value = refFromUrl;
      $("sponsor").setAttribute("disabled", "disabled");
      $("sponsor").style.opacity = "0.9";
      sponsorLocked = true;

      if (sideFromUrl === 0 || sideFromUrl === 1) {
        $("side").value = String(sideFromUrl);
        $("side").setAttribute("disabled", "disabled");
        $("side").style.opacity = "0.9";
      }
      toast("โหลดผู้แนะนำจากลิงก์แล้ว");
    } else {
      $("sponsor").removeAttribute("disabled");
      $("side").removeAttribute("disabled");
      sponsorLocked = false;

      // ถ้าไม่ส่ง ref มา ให้ลอง defaultSponsor จาก core
      try {
        const ds = await core.defaultSponsor();
        $("sponsor").value = (ds && ds !== ethers.ZeroAddress) ? ds : C.DEFAULT_SPONSOR;
      } catch {
        $("sponsor").value = C.DEFAULT_SPONSOR;
      }
    }

    // packages + refresh
    await loadPackages();
    await onPkgChange();
    await refreshAll();

    // events
    window.ethereum.on?.("accountsChanged", () => window.location.reload());
    window.ethereum.on?.("chainChanged", () => window.location.reload());

    $("btnConnect").disabled = true;
    toast("เชื่อมต่อแล้ว");
  }

  // ---------- Bind ----------
  function bind() {
    $("btnConnect").addEventListener("click", connect);
    $("btnApprove").addEventListener("click", approveUSDT);
    $("btnBuy").addEventListener("click", buyPackage);
    $("btnRefresh").addEventListener("click", refreshAll);
    $("btnClaimRef").addEventListener("click", claimReferral);
    $("btnClaimMatch").addEventListener("click", claimMatching);
    $("pkg").addEventListener("change", onPkgChange);

    $("btnCopyLeft").addEventListener("click", async () => {
      if (!user) return toast("ยังไม่เชื่อมต่อ", false);
      const link = buildRefLink(user, 0);
      const ok = await copyText(link);
      toast(ok ? "คัดลอกลิงก์ LEFT แล้ว" : "คัดลอกไม่สำเร็จ", ok);
    });
    $("btnCopyRight").addEventListener("click", async () => {
      if (!user) return toast("ยังไม่เชื่อมต่อ", false);
      const link = buildRefLink(user, 1);
      const ok = await copyText(link);
      toast(ok ? "คัดลอกลิงก์ RIGHT แล้ว" : "คัดลอกไม่สำเร็จ", ok);
    });
    $("btnCopyAddr").addEventListener("click", async () => {
      if (!user) return toast("ยังไม่เชื่อมต่อ", false);
      const ok = await copyText(user);
      toast(ok ? "คัดลอก address แล้ว" : "คัดลอกไม่สำเร็จ", ok);
    });
  }

  // ---------- Init ----------
  (async () => {
    bind();
    await initReadonly();

    // show core
    $("coreText").textContent = short(C.CORE);
    $("coreScan").href = toScan(C.CORE);

    // prepare referral text placeholders (ก่อน connect)
    $("myRefLeft").textContent = "-";
    $("myRefRight").textContent = "-";
    $("walletScan").textContent = "-";
    $("walletScan").href = "#";

    // ถ้าเข้า url มี ref ให้โชว์ sponsor ไว้ก่อน (readonly)
    const rs = readRefSideFromUrl();
    if (rs.ref) {
      $("sponsor").value = rs.ref;
      $("sponsor").setAttribute("disabled", "disabled");
      sponsorLocked = true;

      if (rs.side === 0 || rs.side === 1) {
        $("side").value = String(rs.side);
        $("side").setAttribute("disabled", "disabled");
      }
    }
  })();
})();
