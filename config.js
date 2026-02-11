// ====== CoreV4 + EarningsV2 + Stake365 CONFIG ======
window.APP_CONFIG = {
  CHAIN_ID_DEC: 56,
  CHAIN_ID_HEX: "0x38",
  CHAIN_NAME: "BNB Smart Chain",
  RPC_URL: "https://bsc-dataseed.binance.org/",
  BLOCK_EXPLORER: "https://bscscan.com",

  // ===== Contracts (YOUR DEPLOY) =====
  CORE:     "0x66425FB7dAD286086b9fF024bf1e92A41926A50e", // CoreV4
  EARNINGS: "0xf4e58b87909c68a07327ea3c82450D2Db51e6f0C", // EarningsV2
  STAKE365: "0x575B29195ee74bcdAB538Ab4464BabADA13E24DA", // KJCAutoStake365
  USDT:     "0x55d398326f99059fF775485246999027B3197955", // USDT (18 decimals)

  // UX
  DEFAULT_SPONSOR: "0x0000000000000000000000000000000000000000",

  // URL params
  REF_PARAM: "ref",
  SIDE_PARAM: "side", // L / R
};
