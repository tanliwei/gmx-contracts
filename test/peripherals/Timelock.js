const { expect, use } = require("chai");
const { solidity } = require("ethereum-waffle");
const { deployContract } = require("../shared/fixtures");
const {
  expandDecimals,
  getBlockTime,
  increaseTime,
  mineBlock,
  reportGasUsed,
} = require("../shared/utilities");
const { toChainlinkPrice } = require("../shared/chainlink");
const { toUsd, toNormalizedPrice } = require("../shared/units");
const { initVault } = require("../core/Vault/helpers");

use(solidity);

const { AddressZero } = ethers.constants;

describe("Timelock", function () {
  const provider = waffle.provider;
  const [
    wallet,
    user0,
    user1,
    user2,
    user3,
    rewardManager,
    tokenManager,
    mintReceiver,
    positionRouter,
  ] = provider.getWallets();
  let vault;
  let vaultUtils;
  let vaultPriceFeed;
  let usdg;
  let router;
  let bnb;
  let bnbPriceFeed;
  let btc;
  let btcPriceFeed;
  let dai;
  let daiPriceFeed;
  let distributor0;
  let yieldTracker0;
  let timelock;
  let fastPriceEvents;
  let fastPriceFeed;

  beforeEach(async () => {
    bnb = await deployContract("Token", []);
    bnbPriceFeed = await deployContract("PriceFeed", []);

    btc = await deployContract("Token", []);
    btcPriceFeed = await deployContract("PriceFeed", []);

    dai = await deployContract("Token", []);
    daiPriceFeed = await deployContract("PriceFeed", []);

    vault = await deployContract("Vault", []);
    usdg = await deployContract("USDG", [vault.address]);
    router = await deployContract("Router", [
      vault.address,
      usdg.address,
      bnb.address,
    ]);
    vaultPriceFeed = await deployContract("VaultPriceFeed", []);

    const initVaultResult = await initVault(
      vault,
      router,
      usdg,
      vaultPriceFeed
    );
    vaultUtils = initVaultResult.vaultUtils;

    distributor0 = await deployContract("TimeDistributor", []);
    yieldTracker0 = await deployContract("YieldTracker", [usdg.address]);

    await yieldTracker0.setDistributor(distributor0.address);
    await distributor0.setDistribution(
      [yieldTracker0.address],
      [1000],
      [bnb.address]
    );

    await bnb.mint(distributor0.address, 5000);
    await usdg.setYieldTrackers([yieldTracker0.address]);

    await vault.setPriceFeed(user3.address);

    timelock = await deployContract("Timelock", [
      wallet.address,
      5 * 24 * 60 * 60,
      tokenManager.address,
      mintReceiver.address,
      tokenManager.address,
      mintReceiver.address,
      rewardManager.address,
      expandDecimals(1000, 18),
      50, // marginFeeBasisPoints 0.5%
      500, // maxMarginFeeBasisPoints 5%
    ]);
    await vault.setGov(timelock.address);

    await vaultPriceFeed.setTokenConfig(
      bnb.address,
      bnbPriceFeed.address,
      8,
      false
    );
    await vaultPriceFeed.setTokenConfig(
      dai.address,
      daiPriceFeed.address,
      8,
      false
    );

    await vaultPriceFeed.setGov(timelock.address);
    await router.setGov(timelock.address);

    fastPriceEvents = await deployContract("FastPriceEvents", []);
    fastPriceFeed = await deployContract("FastPriceFeed", [
      5 * 60, // _priceDuration
      2, // _minBlockInterval
      250, // _maxDeviationBasisPoints
      fastPriceEvents.address, // _fastPriceEvents
      tokenManager.address, // _tokenManager
      positionRouter.address, // _positionRouter
    ]);

    await fastPriceFeed.setGov(timelock.address);
  });

  it("inits", async () => {
    expect(await usdg.gov()).eq(wallet.address);
    expect(await usdg.vaults(vault.address)).eq(true);
    expect(await usdg.vaults(user0.address)).eq(false);

    expect(await vault.gov()).eq(timelock.address);
    expect(await vault.isInitialized()).eq(true);
    expect(await vault.router()).eq(router.address);
    expect(await vault.usdg()).eq(usdg.address);
    expect(await vault.liquidationFeeUsd()).eq(toUsd(5));
    expect(await vault.fundingRateFactor()).eq(600000);

    expect(await timelock.admin()).eq(wallet.address);
    expect(await timelock.buffer()).eq(5 * 24 * 60 * 60);
    expect(await timelock.tokenManager()).eq(tokenManager.address);
    expect(await timelock.maxTokenSupply()).eq(expandDecimals(1000, 18));

    await expect(
      deployContract("Timelock", [
        wallet.address,
        5 * 24 * 60 * 60 + 1,
        tokenManager.address,
        mintReceiver.address,
        rewardManager.address,
        tokenManager.address,
        rewardManager.address,
        1000,
        10,
        100,
      ])
    ).to.be.revertedWith("Timelock: invalid _buffer");
  });

  it("setTokenConfig", async () => {
    await timelock
      .connect(wallet)
      .signalSetPriceFeed(vault.address, vaultPriceFeed.address);
    await increaseTime(provider, 5 * 24 * 60 * 60 + 10);
    await mineBlock(provider);
    await timelock
      .connect(wallet)
      .setPriceFeed(vault.address, vaultPriceFeed.address);

    await bnbPriceFeed.setLatestAnswer(500);

    await expect(
      timelock
        .connect(user0)
        .setTokenConfig(vault.address, bnb.address, 100, 200, 1000, 0, 0)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock
        .connect(wallet)
        .setTokenConfig(vault.address, bnb.address, 100, 200, 1000, 0, 0)
    ).to.be.revertedWith("Timelock: token not yet whitelisted");

    await timelock.connect(wallet).signalVaultSetTokenConfig(
      vault.address,
      bnb.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      300, // _minProfitBps
      5000, // _maxUsdgAmount
      false, // _isStable
      true // isShortable
    );

    await increaseTime(provider, 5 * 24 * 60 * 60);
    await mineBlock(provider);

    await timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      bnb.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      300, // _minProfitBps
      5000, // _maxUsdgAmount
      false, // _isStable
      true // isShortable
    );

    expect(await vault.whitelistedTokenCount()).eq(1);
    expect(await vault.totalTokenWeights()).eq(7000);
    expect(await vault.whitelistedTokens(bnb.address)).eq(true);
    expect(await vault.tokenDecimals(bnb.address)).eq(12);
    expect(await vault.tokenWeights(bnb.address)).eq(7000);
    expect(await vault.minProfitBasisPoints(bnb.address)).eq(300);
    expect(await vault.maxUsdgAmounts(bnb.address)).eq(5000);
    expect(await vault.stableTokens(bnb.address)).eq(false);
    expect(await vault.shortableTokens(bnb.address)).eq(true);

    await timelock.connect(wallet).setTokenConfig(
      vault.address,
      bnb.address,
      100, // _tokenWeight
      200, // _minProfitBps
      1000, // _maxUsdgAmount
      300, // _bufferAmount
      500 // _usdgAmount
    );

    expect(await vault.whitelistedTokenCount()).eq(1);
    expect(await vault.totalTokenWeights()).eq(100);
    expect(await vault.whitelistedTokens(bnb.address)).eq(true);
    expect(await vault.tokenDecimals(bnb.address)).eq(12);
    expect(await vault.tokenWeights(bnb.address)).eq(100);
    expect(await vault.minProfitBasisPoints(bnb.address)).eq(200);
    expect(await vault.maxUsdgAmounts(bnb.address)).eq(1000);
    expect(await vault.stableTokens(bnb.address)).eq(false);
    expect(await vault.shortableTokens(bnb.address)).eq(true);
    expect(await vault.bufferAmounts(bnb.address)).eq(300);
    expect(await vault.usdgAmounts(bnb.address)).eq(500);

    await timelock.setContractHandler(user0.address, true);

    await timelock.connect(user0).setTokenConfig(
      vault.address,
      bnb.address,
      100, // _tokenWeight
      50, // _minProfitBps
      1000, // _maxUsdgAmount
      300, // _bufferAmount
      500 // _usdgAmount
    );

    expect(await vault.minProfitBasisPoints(bnb.address)).eq(50);
  });

  it("setBuffer", async () => {
    const timelock0 = await deployContract("Timelock", [
      user1.address,
      3 * 24 * 60 * 60,
      tokenManager.address,
      mintReceiver.address,
      rewardManager.address,
      tokenManager.address,
      rewardManager.address,
      1000,
      10,
      100,
    ]);
    await expect(
      timelock0.connect(user0).setBuffer(3 * 24 * 60 * 60 - 10)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock0.connect(user1).setBuffer(5 * 24 * 60 * 60 + 10)
    ).to.be.revertedWith("Timelock: invalid _buffer");

    await expect(
      timelock0.connect(user1).setBuffer(3 * 24 * 60 * 60 - 10)
    ).to.be.revertedWith("Timelock: buffer cannot be decreased");

    expect(await timelock0.buffer()).eq(3 * 24 * 60 * 60);
    await timelock0.connect(user1).setBuffer(3 * 24 * 60 * 60 + 10);
    expect(await timelock0.buffer()).eq(3 * 24 * 60 * 60 + 10);
  });

  it("setVaultUtils", async () => {
    await expect(
      timelock.connect(user0).setVaultUtils(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.vaultUtils()).eq(vaultUtils.address);
    await timelock.connect(wallet).setVaultUtils(vault.address, user1.address);
    expect(await vault.vaultUtils()).eq(user1.address);
  });

  it("setIsSwapEnabled", async () => {
    await expect(
      timelock.connect(user0).setIsSwapEnabled(vault.address, false)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.isSwapEnabled()).eq(true);
    await timelock.connect(wallet).setIsSwapEnabled(vault.address, false);
    expect(await vault.isSwapEnabled()).eq(false);
  });

  it("setContractHandler", async () => {
    await expect(
      timelock.connect(user0).setContractHandler(user1.address, true)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await timelock.isHandler(user1.address)).eq(false);
    await timelock.connect(wallet).setContractHandler(user1.address, true);
    expect(await timelock.isHandler(user1.address)).eq(true);
  });

  it("setIsLeverageEnabled", async () => {
    await expect(
      timelock.connect(user0).setIsLeverageEnabled(vault.address, false)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.isLeverageEnabled()).eq(true);
    await timelock.connect(wallet).setIsLeverageEnabled(vault.address, false);
    expect(await vault.isLeverageEnabled()).eq(false);

    await timelock.connect(wallet).setIsLeverageEnabled(vault.address, true);
    expect(await vault.isLeverageEnabled()).eq(true);
  });

  it("setMaxGlobalShortSize", async () => {
    await expect(
      timelock
        .connect(user0)
        .setMaxGlobalShortSize(vault.address, bnb.address, 100)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.maxGlobalShortSizes(bnb.address)).eq(0);
    await timelock
      .connect(wallet)
      .setMaxGlobalShortSize(vault.address, bnb.address, 100);
    expect(await vault.maxGlobalShortSizes(bnb.address)).eq(100);
  });

  it("setMaxGasPrice", async () => {
    await expect(
      timelock.connect(user0).setMaxGasPrice(vault.address, 7000000000)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.maxGasPrice()).eq(0);
    await timelock.connect(wallet).setMaxGasPrice(vault.address, 7000000000);
    expect(await vault.maxGasPrice()).eq(7000000000);
  });

  it("setMaxLeverage", async () => {
    await expect(
      timelock.connect(user0).setMaxLeverage(vault.address, 100 * 10000)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).setMaxLeverage(vault.address, 49 * 10000)
    ).to.be.revertedWith("Timelock: invalid _maxLeverage");

    expect(await vault.maxLeverage()).eq(75 * 10000);
    await timelock.connect(wallet).setMaxLeverage(vault.address, 100 * 10000);
    expect(await vault.maxLeverage()).eq(100 * 10000);
  });

  it("setFundingRate", async () => {
    await expect(
      timelock.connect(user0).setFundingRate(vault.address, 59 * 60, 100, 100)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.fundingRateFactor()).eq(600000);
    expect(await vault.stableFundingRateFactor()).eq(600000);
    await timelock
      .connect(wallet)
      .setFundingRate(vault.address, 60 * 60, 0, 100000);
    expect(await vault.fundingRateFactor()).eq(0);
    expect(await vault.stableFundingRateFactor()).eq(100000);

    await timelock
      .connect(wallet)
      .setFundingRate(vault.address, 60 * 60, 100000, 0);
    expect(await vault.fundingInterval()).eq(60 * 60);
    expect(await vault.fundingRateFactor()).eq(100000);
    expect(await vault.stableFundingRateFactor()).eq(0);

    await timelock.setContractHandler(user0.address, true);

    await timelock
      .connect(user0)
      .setFundingRate(vault.address, 120 * 60, 50, 75);
    expect(await vault.fundingInterval()).eq(120 * 60);
    expect(await vault.fundingRateFactor()).eq(50);
    expect(await vault.stableFundingRateFactor()).eq(75);
  });

  it("transferIn", async () => {
    await bnb.mint(user1.address, 1000);
    await expect(
      timelock.connect(user0).transferIn(user1.address, bnb.address, 1000)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).transferIn(user1.address, bnb.address, 1000)
    ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

    await bnb.connect(user1).approve(timelock.address, 1000);

    expect(await bnb.balanceOf(user1.address)).eq(1000);
    expect(await bnb.balanceOf(timelock.address)).eq(0);
    await timelock.connect(wallet).transferIn(user1.address, bnb.address, 1000);
    expect(await bnb.balanceOf(user1.address)).eq(0);
    expect(await bnb.balanceOf(timelock.address)).eq(1000);
  });

  it("approve", async () => {
    await timelock.setContractHandler(user0.address, true);
    await expect(
      timelock
        .connect(user0)
        .approve(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(user0)
        .signalApprove(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock
      .connect(wallet)
      .signalApprove(dai.address, user1.address, expandDecimals(100, 18));

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 4 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
    await mineBlock(provider);

    await expect(
      timelock
        .connect(wallet)
        .approve(bnb.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user2.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user1.address, expandDecimals(101, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await dai.mint(timelock.address, expandDecimals(150, 18));

    expect(await dai.balanceOf(timelock.address)).eq(expandDecimals(150, 18));
    expect(await dai.balanceOf(user1.address)).eq(0);

    await expect(
      dai
        .connect(user1)
        .transferFrom(timelock.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

    await timelock
      .connect(wallet)
      .approve(dai.address, user1.address, expandDecimals(100, 18));
    await expect(
      dai
        .connect(user2)
        .transferFrom(timelock.address, user2.address, expandDecimals(100, 18))
    ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
    await dai
      .connect(user1)
      .transferFrom(timelock.address, user1.address, expandDecimals(100, 18));

    expect(await dai.balanceOf(timelock.address)).eq(expandDecimals(50, 18));
    expect(await dai.balanceOf(user1.address)).eq(expandDecimals(100, 18));

    await expect(
      dai
        .connect(user1)
        .transferFrom(timelock.address, user1.address, expandDecimals(1, 18))
    ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await timelock
      .connect(wallet)
      .signalApprove(dai.address, user1.address, expandDecimals(100, 18));

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    const action0 = ethers.utils.solidityKeccak256(
      ["string", "address", "address", "uint256"],
      ["approve", bnb.address, user1.address, expandDecimals(100, 18)]
    );
    const action1 = ethers.utils.solidityKeccak256(
      ["string", "address", "address", "uint256"],
      ["approve", dai.address, user1.address, expandDecimals(100, 18)]
    );

    await expect(
      timelock.connect(user0).cancelAction(action0)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).cancelAction(action0)
    ).to.be.revertedWith("Timelock: invalid _action");

    await timelock.connect(wallet).cancelAction(action1);

    await expect(
      timelock
        .connect(wallet)
        .approve(dai.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");
  });

  // it("setPriceFeedWatcher", async () => {
  //   await timelock.setContractHandler(user0.address, true);

  //   await expect(
  //     timelock
  //       .connect(user0)
  //       .setPriceFeedWatcher(fastPriceFeed.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: forbidden");

  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .setPriceFeedWatcher(fastPriceFeed.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock
  //       .connect(user0)
  //       .signalSetPriceFeedWatcher(fastPriceFeed.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: forbidden");

  //   await timelock
  //     .connect(wallet)
  //     .signalSetPriceFeedWatcher(fastPriceFeed.address, user1.address, true);

  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .setPriceFeedWatcher(fastPriceFeed.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: action time not yet passed");

  //   await increaseTime(provider, 4 * 24 * 60 * 60);
  //   await mineBlock(provider);

  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .setPriceFeedWatcher(fastPriceFeed.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: action time not yet passed");

  //   await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
  //   await mineBlock(provider);

  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .setPriceFeedWatcher(user2.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .setPriceFeedWatcher(fastPriceFeed.address, user2.address, true)
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .setPriceFeedWatcher(fastPriceFeed.address, user1.address, false)
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   expect(await fastPriceFeed.isSigner(user1.address)).eq(false);
  //   await timelock
  //     .connect(wallet)
  //     .setPriceFeedWatcher(fastPriceFeed.address, user1.address, true);
  //   expect(await fastPriceFeed.isSigner(user1.address)).eq(true);
  // });

  it("processMint", async () => {
    await timelock.setContractHandler(user0.address, true);
    const ktx = await deployContract("KTX", []);
    await ktx.setGov(timelock.address);

    await expect(
      timelock
        .connect(user0)
        .processMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(user0)
        .signalMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock
      .connect(wallet)
      .signalMint(ktx.address, user1.address, expandDecimals(100, 18));

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 4 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
    await mineBlock(provider);

    await expect(
      timelock
        .connect(wallet)
        .processMint(bnb.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user2.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user1.address, expandDecimals(101, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    expect(await ktx.balanceOf(timelock.address)).eq(0);
    expect(await ktx.balanceOf(user1.address)).eq(0);

    await timelock
      .connect(wallet)
      .processMint(ktx.address, user1.address, expandDecimals(100, 18));

    expect(await ktx.balanceOf(timelock.address)).eq(0);
    expect(await ktx.balanceOf(user1.address)).eq(expandDecimals(100, 18));

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await timelock
      .connect(wallet)
      .signalMint(ktx.address, user1.address, expandDecimals(100, 18));

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    const action0 = ethers.utils.solidityKeccak256(
      ["string", "address", "address", "uint256"],
      ["mint", bnb.address, user1.address, expandDecimals(100, 18)]
    );
    const action1 = ethers.utils.solidityKeccak256(
      ["string", "address", "address", "uint256"],
      ["mint", ktx.address, user1.address, expandDecimals(100, 18)]
    );

    await expect(
      timelock.connect(user0).cancelAction(action0)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).cancelAction(action0)
    ).to.be.revertedWith("Timelock: invalid _action");

    await timelock.connect(wallet).cancelAction(action1);

    await expect(
      timelock
        .connect(wallet)
        .processMint(ktx.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action not signalled");
  });

  it("setHandler", async () => {
    await timelock.setContractHandler(user0.address, true);
    const vester = await deployContract("Vester", [
      "Vested KTX",
      "veKTX",
      365 * 24 * 60 * 60,
      AddressZero,
      AddressZero,
      AddressZero,
      AddressZero,
    ]);
    await vester.setGov(timelock.address);

    await expect(
      timelock.connect(user0).setHandler(vester.address, user1.address, true)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).setHandler(vester.address, user1.address, true)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(user0)
        .signalSetHandler(vester.address, user1.address, true)
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock
      .connect(wallet)
      .signalSetHandler(vester.address, user1.address, true);

    await expect(
      timelock.connect(wallet).setHandler(vester.address, user1.address, true)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 4 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).setHandler(vester.address, user1.address, true)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).setHandler(bnb.address, user1.address, true)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock.connect(wallet).setHandler(vester.address, user2.address, true)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock.connect(wallet).setHandler(vester.address, user1.address, false)
    ).to.be.revertedWith("Timelock: action not signalled");

    expect(await vester.isHandler(user1.address)).eq(false);
    await timelock
      .connect(wallet)
      .setHandler(vester.address, user1.address, true);
    expect(await vester.isHandler(user1.address)).eq(true);

    await expect(
      timelock.connect(wallet).setHandler(vester.address, user1.address, true)
    ).to.be.revertedWith("Timelock: action not signalled");

    await timelock
      .connect(wallet)
      .signalSetHandler(vester.address, user1.address, true);

    await expect(
      timelock
        .connect(wallet)
        .setHandler(vester.address, user1.address, expandDecimals(100, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    const action0 = ethers.utils.solidityKeccak256(
      ["string", "address", "address", "bool"],
      ["setHandler", bnb.address, user1.address, true]
    );
    const action1 = ethers.utils.solidityKeccak256(
      ["string", "address", "address", "bool"],
      ["setHandler", vester.address, user1.address, true]
    );

    await expect(
      timelock.connect(user0).cancelAction(action0)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).cancelAction(action0)
    ).to.be.revertedWith("Timelock: invalid _action");

    await timelock.connect(wallet).cancelAction(action1);

    await expect(
      timelock.connect(wallet).setHandler(vester.address, user1.address, true)
    ).to.be.revertedWith("Timelock: action not signalled");
  });

  it("setGov", async () => {
    await timelock.setContractHandler(user0.address, true);

    await expect(
      timelock.connect(user0).setGov(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).setGov(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock.connect(user0).signalSetGov(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock.connect(wallet).signalSetGov(vault.address, user1.address);

    await expect(
      timelock.connect(wallet).setGov(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 4 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).setGov(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).setGov(user2.address, user1.address)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock.connect(wallet).setGov(vault.address, user2.address)
    ).to.be.revertedWith("Timelock: action not signalled");

    expect(await vault.gov()).eq(timelock.address);
    await timelock.connect(wallet).setGov(vault.address, user1.address);
    expect(await vault.gov()).eq(user1.address);

    await timelock.connect(wallet).signalSetGov(vault.address, user2.address);

    await expect(
      timelock.connect(wallet).setGov(vault.address, user2.address)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    const action0 = ethers.utils.solidityKeccak256(
      ["string", "address", "address"],
      ["setGov", user1.address, user2.address]
    );
    const action1 = ethers.utils.solidityKeccak256(
      ["string", "address", "address"],
      ["setGov", vault.address, user2.address]
    );

    await expect(
      timelock.connect(wallet).cancelAction(action0)
    ).to.be.revertedWith("Timelock: invalid _action");

    await timelock.connect(wallet).cancelAction(action1);

    await expect(
      timelock.connect(wallet).setGov(vault.address, user2.address)
    ).to.be.revertedWith("Timelock: action not signalled");
  });

  it("setPriceFeed", async () => {
    await timelock.setContractHandler(user0.address, true);

    await expect(
      timelock.connect(user0).setPriceFeed(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).setPriceFeed(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock.connect(user0).signalSetPriceFeed(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock
      .connect(wallet)
      .signalSetPriceFeed(vault.address, user1.address);

    await expect(
      timelock.connect(wallet).setPriceFeed(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 4 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).setPriceFeed(vault.address, user1.address)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).setPriceFeed(user2.address, user1.address)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock.connect(wallet).setPriceFeed(vault.address, user2.address)
    ).to.be.revertedWith("Timelock: action not signalled");

    expect(await vault.priceFeed()).eq(user3.address);
    await timelock.connect(wallet).setPriceFeed(vault.address, user1.address);
    expect(await vault.priceFeed()).eq(user1.address);

    await timelock
      .connect(wallet)
      .signalSetPriceFeed(vault.address, user2.address);

    await expect(
      timelock.connect(wallet).setPriceFeed(vault.address, user2.address)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    const action0 = ethers.utils.solidityKeccak256(
      ["string", "address", "address"],
      ["setPriceFeed", user1.address, user2.address]
    );
    const action1 = ethers.utils.solidityKeccak256(
      ["string", "address", "address"],
      ["setPriceFeed", vault.address, user2.address]
    );

    await expect(
      timelock.connect(wallet).cancelAction(action0)
    ).to.be.revertedWith("Timelock: invalid _action");

    await timelock.connect(wallet).cancelAction(action1);

    await expect(
      timelock.connect(wallet).setPriceFeed(vault.address, user2.address)
    ).to.be.revertedWith("Timelock: action not signalled");
  });

  it("withdrawToken", async () => {
    await timelock.setContractHandler(user0.address, true);

    const ktx = await deployContract("KTX", []);
    await ktx.setGov(timelock.address);

    await expect(
      timelock
        .connect(user0)
        .withdrawToken(ktx.address, bnb.address, user0.address, 100)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(ktx.address, bnb.address, user0.address, 100)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(user0)
        .signalWithdrawToken(ktx.address, bnb.address, user0.address, 100)
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock
      .connect(wallet)
      .signalWithdrawToken(ktx.address, bnb.address, user0.address, 100);

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(ktx.address, bnb.address, user0.address, 100)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 4 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(ktx.address, bnb.address, user0.address, 100)
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
    await mineBlock(provider);

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(dai.address, bnb.address, user0.address, 100)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(ktx.address, dai.address, user0.address, 100)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(ktx.address, bnb.address, user1.address, 100)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(ktx.address, bnb.address, user0.address, 101)
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(wallet)
        .withdrawToken(ktx.address, bnb.address, user0.address, 100)
    ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

    await bnb.mint(ktx.address, 100);
    expect(await bnb.balanceOf(user0.address)).eq(0);
    await timelock
      .connect(wallet)
      .withdrawToken(ktx.address, bnb.address, user0.address, 100);
    expect(await bnb.balanceOf(user0.address)).eq(100);
  });

  it("vaultSetTokenConfig", async () => {
    await timelock.setContractHandler(user0.address, true);

    await timelock
      .connect(wallet)
      .signalSetPriceFeed(vault.address, vaultPriceFeed.address);
    await increaseTime(provider, 5 * 24 * 60 * 60 + 10);
    await mineBlock(provider);
    await timelock
      .connect(wallet)
      .setPriceFeed(vault.address, vaultPriceFeed.address);

    await daiPriceFeed.setLatestAnswer(1);

    await expect(
      timelock.connect(user0).vaultSetTokenConfig(
        vault.address,
        dai.address, // _token
        12, // _tokenDecimals
        7000, // _tokenWeight
        120, // _minProfitBps
        5000, // _maxUsdgAmount
        true, // _isStable
        false // isShortable
      )
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).vaultSetTokenConfig(
        vault.address,
        dai.address, // _token
        12, // _tokenDecimals
        7000, // _tokenWeight
        120, // _minProfitBps
        5000, // _maxUsdgAmount
        true, // _isStable
        false // isShortable
      )
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock.connect(user0).signalVaultSetTokenConfig(
        vault.address,
        dai.address, // _token
        12, // _tokenDecimals
        7000, // _tokenWeight
        120, // _minProfitBps
        5000, // _maxUsdgAmount
        true, // _isStable
        false // isShortable
      )
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock.connect(wallet).signalVaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    );

    await expect(
      timelock.connect(wallet).vaultSetTokenConfig(
        vault.address,
        dai.address, // _token
        12, // _tokenDecimals
        7000, // _tokenWeight
        120, // _minProfitBps
        5000, // _maxUsdgAmount
        true, // _isStable
        false // isShortable
      )
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 4 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).vaultSetTokenConfig(
        vault.address,
        dai.address, // _token
        12, // _tokenDecimals
        7000, // _tokenWeight
        120, // _minProfitBps
        5000, // _maxUsdgAmount
        true, // _isStable
        false // isShortable
      )
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
    await mineBlock(provider);

    await expect(
      timelock.connect(wallet).vaultSetTokenConfig(
        vault.address,
        dai.address, // _token
        15, // _tokenDecimals
        7000, // _tokenWeight
        120, // _minProfitBps
        5000, // _maxUsdgAmount
        true, // _isStable
        false // isShortable
      )
    ).to.be.revertedWith("Timelock: action not signalled");

    expect(await vault.totalTokenWeights()).eq(0);
    expect(await vault.whitelistedTokens(dai.address)).eq(false);
    expect(await vault.tokenDecimals(dai.address)).eq(0);
    expect(await vault.tokenWeights(dai.address)).eq(0);
    expect(await vault.minProfitBasisPoints(dai.address)).eq(0);
    expect(await vault.maxUsdgAmounts(dai.address)).eq(0);
    expect(await vault.stableTokens(dai.address)).eq(false);
    expect(await vault.shortableTokens(dai.address)).eq(false);

    await timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      dai.address, // _token
      12, // _tokenDecimals
      7000, // _tokenWeight
      120, // _minProfitBps
      5000, // _maxUsdgAmount
      true, // _isStable
      false // isShortable
    );

    expect(await vault.totalTokenWeights()).eq(7000);
    expect(await vault.whitelistedTokens(dai.address)).eq(true);
    expect(await vault.tokenDecimals(dai.address)).eq(12);
    expect(await vault.tokenWeights(dai.address)).eq(7000);
    expect(await vault.minProfitBasisPoints(dai.address)).eq(120);
    expect(await vault.maxUsdgAmounts(dai.address)).eq(5000);
    expect(await vault.stableTokens(dai.address)).eq(true);
    expect(await vault.shortableTokens(dai.address)).eq(false);
  });

  // it("priceFeedSetTokenConfig", async () => {
  //   await timelock.setContractHandler(user0.address, true);

  //   await timelock
  //     .connect(wallet)
  //     .signalSetPriceFeed(vault.address, vaultPriceFeed.address);
  //   await increaseTime(provider, 5 * 24 * 60 * 60 + 10);
  //   await mineBlock(provider);
  //   await timelock
  //     .connect(wallet)
  //     .setPriceFeed(vault.address, vaultPriceFeed.address);

  //   await btcPriceFeed.setLatestAnswer(toChainlinkPrice(70000));

  //   await expect(
  //     timelock.connect(user0).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: forbidden");

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock.connect(user0).signalPriceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: forbidden");

  //   await timelock.connect(wallet).signalPriceFeedSetTokenConfig(
  //     vaultPriceFeed.address,
  //     btc.address, // _token
  //     btcPriceFeed.address, // _priceFeed
  //     8, // _priceDecimals
  //     true // _isStrictStable
  //   );

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action time not yet passed");

  //   await increaseTime(provider, 4 * 24 * 60 * 60);
  //   await mineBlock(provider);

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action time not yet passed");

  //   await increaseTime(provider, 1 * 24 * 60 * 60 + 10);
  //   await mineBlock(provider);

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       user0.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       bnb.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       bnbPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       9, // _priceDecimals
  //       true // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   await expect(
  //     timelock.connect(wallet).priceFeedSetTokenConfig(
  //       vaultPriceFeed.address,
  //       btc.address, // _token
  //       btcPriceFeed.address, // _priceFeed
  //       8, // _priceDecimals
  //       false // _isStrictStable
  //     )
  //   ).to.be.revertedWith("Timelock: action not signalled");

  //   expect(await vaultPriceFeed.priceFeeds(btc.address)).eq(AddressZero);
  //   expect(await vaultPriceFeed.priceDecimals(btc.address)).eq(0);
  //   expect(await vaultPriceFeed.strictStableTokens(btc.address)).eq(false);
  //   await expect(
  //     vaultPriceFeed.getPrice(btc.address, true, false, false)
  //   ).to.be.revertedWith("VaultPriceFeed: invalid price feed");

  //   await timelock.connect(wallet).priceFeedSetTokenConfig(
  //     vaultPriceFeed.address,
  //     btc.address, // _token
  //     btcPriceFeed.address, // _priceFeed
  //     8, // _priceDecimals
  //     true // _isStrictStable
  //   );

  //   expect(await vaultPriceFeed.priceFeeds(btc.address)).eq(
  //     btcPriceFeed.address
  //   );
  //   expect(await vaultPriceFeed.priceDecimals(btc.address)).eq(8);
  //   expect(await vaultPriceFeed.strictStableTokens(btc.address)).eq(true);
  //   expect(await vaultPriceFeed.getPrice(btc.address, true, false, false)).eq(
  //     toNormalizedPrice(70000)
  //   );
  // });

  it("setInPrivateTransferMode", async () => {
    const ktx = await deployContract("KTX", []);
    await ktx.setMinter(wallet.address, true);
    await ktx.mint(user0.address, 100);
    await expect(
      timelock.connect(user0).setInPrivateTransferMode(ktx.address, true)
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock.connect(wallet).setInPrivateTransferMode(ktx.address, true)
    ).to.be.revertedWith("BaseToken: forbidden");

    await ktx.setGov(timelock.address);

    expect(await ktx.inPrivateTransferMode()).eq(false);
    await timelock.connect(wallet).setInPrivateTransferMode(ktx.address, true);
    expect(await ktx.inPrivateTransferMode()).eq(true);

    await timelock.connect(wallet).setInPrivateTransferMode(ktx.address, false);
    expect(await ktx.inPrivateTransferMode()).eq(false);

    await timelock.connect(wallet).setInPrivateTransferMode(ktx.address, true);
    expect(await ktx.inPrivateTransferMode()).eq(true);

    await expect(
      ktx.connect(user0).transfer(user1.address, 100)
    ).to.be.revertedWith("BaseToken: msg.sender not whitelisted");

    await timelock.connect(wallet).setInPrivateTransferMode(ktx.address, false);
    expect(await ktx.inPrivateTransferMode()).eq(false);

    await ktx.connect(user0).transfer(user1.address, 100);
  });

  it("batchSetBonusRewards", async () => {
    const vester = await deployContract("Vester", [
      "Vested KTX",
      "veKTX",
      365 * 24 * 60 * 60,
      AddressZero,
      AddressZero,
      AddressZero,
      AddressZero,
    ]);
    await vester.setGov(timelock.address);

    const accounts = [user1.address, user2.address, user3.address];
    const amounts = [700, 500, 900];

    await expect(
      timelock
        .connect(user0)
        .batchSetBonusRewards(vester.address, accounts, amounts)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vester.bonusRewards(user1.address)).eq(0);
    expect(await vester.bonusRewards(user2.address)).eq(0);
    expect(await vester.bonusRewards(user3.address)).eq(0);
    await timelock
      .connect(wallet)
      .batchSetBonusRewards(vester.address, accounts, amounts);
    expect(await vester.bonusRewards(user1.address)).eq(700);
    expect(await vester.bonusRewards(user2.address)).eq(500);
    expect(await vester.bonusRewards(user3.address)).eq(900);
  });

  // it("managedSetMinter", async () => {
  //   const ktx = await deployContract("KTX", []);
  //   await ktx.setGov(timelock.address);
  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .managedSetMinter(ktx.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: forbidden");

  //   expect(await ktx.isMinter(user1.address)).eq(false);
  //   await timelock
  //     .connect(rewardManager)
  //     .managedSetMinter(ktx.address, user1.address, true);
  //   expect(await ktx.isMinter(user1.address)).eq(true);
  // });

  // it("managedSetHandler", async () => {
  //   const vester = await deployContract("Vester", [
  //     "Vested KTX",
  //     "veKTX",
  //     365 * 24 * 60 * 60,
  //     AddressZero,
  //     AddressZero,
  //     AddressZero,
  //     AddressZero,
  //   ]);
  //   await vester.setGov(timelock.address);

  //   await expect(
  //     timelock
  //       .connect(wallet)
  //       .managedSetHandler(vester.address, user1.address, true)
  //   ).to.be.revertedWith("Timelock: forbidden");

  //   expect(await vester.isHandler(user1.address)).eq(false);
  //   await timelock
  //     .connect(rewardManager)
  //     .managedSetHandler(vester.address, user1.address, true);
  //   expect(await vester.isHandler(user1.address)).eq(true);
  // });

  it("setAdmin", async () => {
    await expect(timelock.setAdmin(user1.address)).to.be.revertedWith(
      "Timelock: forbidden"
    );

    expect(await timelock.admin()).eq(wallet.address);
    await timelock.connect(tokenManager).setAdmin(user1.address);
    expect(await timelock.admin()).eq(user1.address);
  });

  it("setExternalAdmin", async () => {
    const distributor = await deployContract("RewardDistributor", [
      user1.address,
      user2.address,
    ]);
    await distributor.setGov(timelock.address);
    await expect(
      timelock
        .connect(user0)
        .setExternalAdmin(distributor.address, user3.address)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await distributor.admin()).eq(wallet.address);
    await timelock
      .connect(wallet)
      .setExternalAdmin(distributor.address, user3.address);
    expect(await distributor.admin()).eq(user3.address);

    await expect(
      timelock.connect(wallet).setExternalAdmin(timelock.address, user3.address)
    ).to.be.revertedWith("Timelock: invalid _target");
  });

  it("setShouldToggleIsLeverageEnabled", async () => {
    await expect(
      timelock.connect(user0).setShouldToggleIsLeverageEnabled(true)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await timelock.shouldToggleIsLeverageEnabled()).to.be.false;
    await expect(timelock.setShouldToggleIsLeverageEnabled(true));
    expect(await timelock.shouldToggleIsLeverageEnabled()).to.be.true;
    await expect(timelock.setShouldToggleIsLeverageEnabled(false));
    expect(await timelock.shouldToggleIsLeverageEnabled()).to.be.false;

    await timelock.setContractHandler(user0.address, true);
    await timelock.connect(user0).setShouldToggleIsLeverageEnabled(true);
    expect(await timelock.shouldToggleIsLeverageEnabled()).to.be.true;
  });

  it("setMarginFeeBasisPoints", async () => {
    await expect(
      timelock.connect(user0).setMarginFeeBasisPoints(100, 1000)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await timelock.marginFeeBasisPoints()).eq(50);
    expect(await timelock.maxMarginFeeBasisPoints()).eq(500);

    await timelock.setMarginFeeBasisPoints(100, 1000);
    expect(await timelock.marginFeeBasisPoints()).eq(100);
    expect(await timelock.maxMarginFeeBasisPoints()).eq(1000);

    await timelock.setContractHandler(user0.address, true);
    await timelock.connect(user0).setMarginFeeBasisPoints(20, 200);
    expect(await timelock.marginFeeBasisPoints()).eq(20);
    expect(await timelock.maxMarginFeeBasisPoints()).eq(200);
  });

  it("setFees", async () => {
    await expect(
      timelock.connect(user0).setFees(
        vault.address,
        1, // _taxBasisPoints,
        2, // _stableTaxBasisPoints,
        3, // _mintBurnFeeBasisPoints,
        4, // _swapFeeBasisPoints,
        5, // _stableSwapFeeBasisPoints,
        6, // _marginFeeBasisPoints,
        7, // _liquidationFeeUsd,
        8, // _minProfitTime,
        false
      )
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.taxBasisPoints()).eq(50);
    expect(await vault.stableTaxBasisPoints()).eq(20);
    expect(await vault.mintBurnFeeBasisPoints()).eq(30);
    expect(await vault.swapFeeBasisPoints()).eq(30);
    expect(await vault.stableSwapFeeBasisPoints()).eq(4);
    expect(await timelock.marginFeeBasisPoints()).eq(50);
    expect(await vault.marginFeeBasisPoints()).eq(10);
    expect(await vault.liquidationFeeUsd()).eq(toUsd(5));
    expect(await vault.minProfitTime()).eq(0);
    expect(await vault.hasDynamicFees()).eq(false);

    await timelock.connect(wallet).setFees(
      vault.address,
      1, // _taxBasisPoints,
      2, // _stableTaxBasisPoints,
      3, // _mintBurnFeeBasisPoints,
      4, // _swapFeeBasisPoints,
      5, // _stableSwapFeeBasisPoints,
      6, // _marginFeeBasisPoints,
      7, // _liquidationFeeUsd,
      8, // _minProfitTime,
      false // _hasDynamicFees
    );

    expect(await vault.taxBasisPoints()).eq(1);
    expect(await vault.stableTaxBasisPoints()).eq(2);
    expect(await vault.mintBurnFeeBasisPoints()).eq(3);
    expect(await vault.swapFeeBasisPoints()).eq(4);
    expect(await vault.stableSwapFeeBasisPoints()).eq(5);
    expect(await timelock.marginFeeBasisPoints()).eq(6);
    expect(await vault.marginFeeBasisPoints()).eq(500);
    expect(await vault.liquidationFeeUsd()).eq(7);
    expect(await vault.minProfitTime()).eq(8);
    expect(await vault.hasDynamicFees()).eq(false);

    await timelock.setContractHandler(user0.address, true);

    await timelock.connect(wallet).setFees(
      vault.address,
      11, // _taxBasisPoints,
      12, // _stableTaxBasisPoints,
      13, // _mintBurnFeeBasisPoints,
      14, // _swapFeeBasisPoints,
      15, // _stableSwapFeeBasisPoints,
      16, // _marginFeeBasisPoints,
      17, // _liquidationFeeUsd,
      18, // _minProfitTime,
      true // _hasDynamicFees
    );

    expect(await vault.taxBasisPoints()).eq(11);
    expect(await vault.stableTaxBasisPoints()).eq(12);
    expect(await vault.mintBurnFeeBasisPoints()).eq(13);
    expect(await vault.swapFeeBasisPoints()).eq(14);
    expect(await vault.stableSwapFeeBasisPoints()).eq(15);
    expect(await timelock.marginFeeBasisPoints()).eq(16);
    expect(await vault.marginFeeBasisPoints()).eq(500);
    expect(await vault.liquidationFeeUsd()).eq(17);
    expect(await vault.minProfitTime()).eq(18);
    expect(await vault.hasDynamicFees()).eq(true);
  });

  it("setSwapFees", async () => {
    await expect(
      timelock.connect(user0).setSwapFees(
        vault.address,
        1, // _taxBasisPoints,
        2, // _stableTaxBasisPoints,
        3, // _mintBurnFeeBasisPoints,
        4, // _swapFeeBasisPoints,
        5 // _stableSwapFeeBasisPoints
      )
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.taxBasisPoints()).eq(50);
    expect(await vault.stableTaxBasisPoints()).eq(20);
    expect(await vault.mintBurnFeeBasisPoints()).eq(30);
    expect(await vault.swapFeeBasisPoints()).eq(30);
    expect(await vault.stableSwapFeeBasisPoints()).eq(4);
    expect(await timelock.marginFeeBasisPoints()).eq(50);
    expect(await vault.marginFeeBasisPoints()).eq(10);
    expect(await vault.liquidationFeeUsd()).eq(toUsd(5));
    expect(await vault.minProfitTime()).eq(0);
    expect(await vault.hasDynamicFees()).eq(false);

    await timelock.connect(wallet).setSwapFees(
      vault.address,
      1, // _taxBasisPoints,
      2, // _stableTaxBasisPoints,
      3, // _mintBurnFeeBasisPoints,
      4, // _swapFeeBasisPoints,
      5 // _stableSwapFeeBasisPoints
    );

    expect(await vault.taxBasisPoints()).eq(1);
    expect(await vault.stableTaxBasisPoints()).eq(2);
    expect(await vault.mintBurnFeeBasisPoints()).eq(3);
    expect(await vault.swapFeeBasisPoints()).eq(4);
    expect(await vault.stableSwapFeeBasisPoints()).eq(5);
    expect(await timelock.marginFeeBasisPoints()).eq(50);
    expect(await vault.marginFeeBasisPoints()).eq(500);
    expect(await vault.liquidationFeeUsd()).eq(toUsd(5));
    expect(await vault.minProfitTime()).eq(0);
    expect(await vault.hasDynamicFees()).eq(false);

    await timelock.setContractHandler(user0.address, true);

    await timelock.connect(wallet).setSwapFees(
      vault.address,
      11, // _taxBasisPoints,
      12, // _stableTaxBasisPoints,
      13, // _mintBurnFeeBasisPoints,
      14, // _swapFeeBasisPoints,
      15 // _stableSwapFeeBasisPoints
    );

    expect(await vault.taxBasisPoints()).eq(11);
    expect(await vault.stableTaxBasisPoints()).eq(12);
    expect(await vault.mintBurnFeeBasisPoints()).eq(13);
    expect(await vault.swapFeeBasisPoints()).eq(14);
    expect(await vault.stableSwapFeeBasisPoints()).eq(15);
    expect(await timelock.marginFeeBasisPoints()).eq(50);
    expect(await vault.marginFeeBasisPoints()).eq(500);
    expect(await vault.liquidationFeeUsd()).eq(toUsd(5));
    expect(await vault.minProfitTime()).eq(0);
    expect(await vault.hasDynamicFees()).eq(false);
  });

  it("toggle leverage", async () => {
    await expect(
      timelock.connect(user0).enableLeverage(vault.address)
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock.setMarginFeeBasisPoints(10, 100);
    await expect(timelock.setShouldToggleIsLeverageEnabled(true));
    const initialTaxBasisPoints = await vault.taxBasisPoints();

    expect(await vault.isLeverageEnabled()).to.be.true;

    await timelock.disableLeverage(vault.address);
    expect(await vault.taxBasisPoints()).to.be.equal(initialTaxBasisPoints);
    expect(await vault.marginFeeBasisPoints()).eq(100);
    expect(await vault.isLeverageEnabled()).to.be.false;

    await timelock.enableLeverage(vault.address);
    expect(await vault.taxBasisPoints()).to.be.equal(initialTaxBasisPoints);
    expect(await vault.marginFeeBasisPoints()).eq(10);
    expect(await vault.isLeverageEnabled()).to.be.true;

    await expect(timelock.setShouldToggleIsLeverageEnabled(false));
    await timelock.disableLeverage(vault.address);
    expect(await vault.taxBasisPoints()).to.be.equal(initialTaxBasisPoints);
    expect(await vault.marginFeeBasisPoints()).eq(100);
    expect(await vault.isLeverageEnabled()).to.be.true;

    await expect(timelock.setShouldToggleIsLeverageEnabled(true));
    await timelock.disableLeverage(vault.address);
    await expect(timelock.setShouldToggleIsLeverageEnabled(false));
    await timelock.enableLeverage(vault.address);
    expect(await vault.taxBasisPoints()).to.be.equal(initialTaxBasisPoints);
    expect(await vault.marginFeeBasisPoints()).eq(10);
    expect(await vault.isLeverageEnabled()).to.be.false;
  });

  it("setInPrivateLiquidationMode", async () => {
    await expect(
      timelock.connect(user0).setInPrivateLiquidationMode(vault.address, true)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.inPrivateLiquidationMode()).eq(false);
    await timelock
      .connect(wallet)
      .setInPrivateLiquidationMode(vault.address, true);
    expect(await vault.inPrivateLiquidationMode()).eq(true);

    await timelock
      .connect(wallet)
      .setInPrivateLiquidationMode(vault.address, false);
    expect(await vault.inPrivateLiquidationMode()).eq(false);
  });

  it("setLiquidator", async () => {
    await expect(
      timelock.connect(user0).setLiquidator(vault.address, user1.address, true)
    ).to.be.revertedWith("Timelock: forbidden");

    expect(await vault.isLiquidator(user1.address)).eq(false);
    await timelock
      .connect(wallet)
      .setLiquidator(vault.address, user1.address, true);
    expect(await vault.isLiquidator(user1.address)).eq(true);

    await timelock
      .connect(wallet)
      .setLiquidator(vault.address, user1.address, false);
    expect(await vault.isLiquidator(user1.address)).eq(false);

    await expect(
      vault
        .connect(user1)
        .liquidatePosition(
          user0.address,
          bnb.address,
          bnb.address,
          true,
          user2.address
        )
    ).to.be.revertedWith("Vault: empty position");

    await timelock
      .connect(wallet)
      .setInPrivateLiquidationMode(vault.address, true);

    await expect(
      vault
        .connect(user1)
        .liquidatePosition(
          user0.address,
          bnb.address,
          bnb.address,
          true,
          user2.address
        )
    ).to.be.revertedWith("Vault: invalid liquidator");

    await timelock
      .connect(wallet)
      .setLiquidator(vault.address, user1.address, true);

    await expect(
      vault
        .connect(user1)
        .liquidatePosition(
          user0.address,
          bnb.address,
          bnb.address,
          true,
          user2.address
        )
    ).to.be.revertedWith("Vault: empty position");
  });

  it("redeemUsdg", async () => {
    await timelock.setContractHandler(user0.address, true);

    await expect(
      timelock
        .connect(user0)
        .redeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18))
    ).to.be.revertedWith("Timelock: forbidden");

    await expect(
      timelock
        .connect(wallet)
        .redeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18))
    ).to.be.revertedWith("Timelock: action not signalled");

    await expect(
      timelock
        .connect(user0)
        .signalRedeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18))
    ).to.be.revertedWith("Timelock: forbidden");

    await timelock
      .connect(wallet)
      .signalRedeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18));

    await expect(
      timelock
        .connect(wallet)
        .redeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18))
    ).to.be.revertedWith("Timelock: action time not yet passed");

    await increaseTime(provider, 5 * 24 * 60 * 60);
    await mineBlock(provider);

    await expect(
      timelock
        .connect(wallet)
        .redeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18))
    ).to.be.revertedWith("YieldToken: forbidden");

    await usdg.setGov(timelock.address);

    await expect(
      timelock
        .connect(wallet)
        .redeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18))
    ).to.be.revertedWith("Vault: _token not whitelisted");

    await timelock
      .connect(wallet)
      .signalSetPriceFeed(vault.address, vaultPriceFeed.address);
    await increaseTime(provider, 5 * 24 * 60 * 60 + 10);
    await mineBlock(provider);
    await timelock
      .connect(wallet)
      .setPriceFeed(vault.address, vaultPriceFeed.address);

    await bnbPriceFeed.setLatestAnswer(toChainlinkPrice(500));

    await timelock.connect(wallet).signalVaultSetTokenConfig(
      vault.address,
      bnb.address, // _token
      18, // _tokenDecimals
      7000, // _tokenWeight
      300, // _minProfitBps
      expandDecimals(5000, 18), // _maxUsdgAmount
      false, // _isStable
      true // isShortable
    );

    await increaseTime(provider, 5 * 24 * 60 * 60);
    await mineBlock(provider);

    await timelock.connect(wallet).vaultSetTokenConfig(
      vault.address,
      bnb.address, // _token
      18, // _tokenDecimals
      7000, // _tokenWeight
      300, // _minProfitBps
      expandDecimals(5000, 18), // _maxUsdgAmount
      false, // _isStable
      true // isShortable
    );

    await bnb.mint(vault.address, expandDecimals(3, 18));
    await vault.buyUSDG(bnb.address, user3.address);

    await timelock.signalSetGov(vault.address, user1.address);

    await increaseTime(provider, 5 * 24 * 60 * 60);
    await mineBlock(provider);

    await timelock.setGov(vault.address, user1.address);
    await vault.connect(user1).setInManagerMode(true);
    await vault.connect(user1).setGov(timelock.address);

    expect(await bnb.balanceOf(mintReceiver.address)).eq(0);
    await timelock
      .connect(wallet)
      .redeemUsdg(vault.address, bnb.address, expandDecimals(1000, 18));
    expect(await bnb.balanceOf(mintReceiver.address)).eq("1994000000000000000"); // 1.994
  });
});
