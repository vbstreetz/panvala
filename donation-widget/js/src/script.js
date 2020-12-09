import _camelCase from 'lodash/camelCase';
import _bindAll from 'lodash/bindAll';
import bign from 'big.js';
import * as qs from './qs';
import debug from './debug';

const INFURA_ID = process.env.INFURA_ID;
const IFRAME_HOST = process.env.IFRAME_HOST;
const PRECISION = 4;
const ETH_ONE_INCH_ADDR = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ONE_SPLIT_ADDRESS = '1proto.eth'; // '1split.eth';
const UNISWAP_ROUTER_V2_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const TOKEN_CONTRACT_ADDRESSES = {
  DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
  PAN: '0xd56dac73a4d6766464b38ec6d91eb45ce7457c44',
  WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
};
const COIN_GECKO_IDS = {
  ETH: 'ethereum',
  DAI: 'dai',
  PAN: 'panvala-pan',
};
const UNISWAP_DEADLINE_MINUTES = 10;

class Donate {
  constructor(options) {
    _bindAll(this, 'handleMessage');

    this.options = options;
    this.sid = Date.now();
    this.handleMessages();
    this.createIframe();
  }

  handleMessages() {
    if (window.addEventListener) {
      window.addEventListener('message', this.handleMessage, false);
    } else {
      window.attachEvent('onmessage', this.handleMessage);
    }
  }

  close() {
    if (window.removeEventListener) {
      window.removeEventListener('message', this.handleMessage, false);
    } else {
      window.detachEvent('onmessage', this.handleMessage);
    }

    document.body.removeChild(this.iframe);
  }

  handleMessage(evt) {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    debug('msg: %s', msg.sid);
    if (parseInt(msg.sid) !== parseInt(this.sid)) {
      return debug('ignoring msg(%s) self(%s)', msg.sid, this.sid);
    }
    debug('msg %o', msg);
    const meth = _camelCase('on-' + msg.type);
    if (!this[meth]) return debug('unknown msg type %s', meth);
    this[meth](msg.sid, msg.payload);
  }

  postMessageToIframe(sid, type, payload = {}) {
    this.iframe.contentWindow.postMessage(
      JSON.stringify({ type, payload, sid }),
      IFRAME_HOST
    );
  }

  validateOptions({ to, defaultUSDAmount }) {
    // todo: validate `to` address

    // validate `defaultUSDAmount`
    defaultUSDAmount = Number(defaultUSDAmount);
    if (defaultUSDAmount <= 0) throw new Error('invalid default usd amount');

    return {
      to,
      defaultUSDAmount,
    };
  }

  createIframe() {
    const { sid, options } = this;

    try {
      const url =
        IFRAME_HOST +
        '?' +
        qs.stringify({
          options: btoa(
            JSON.stringify({
              sid,
              host: location.origin,
              ...this.validateOptions(options),
            })
          ),
        });

      debug(url);

      const iframe = (this.iframe = document.createElement('iframe'));
      iframe.setAttribute('src', url);
      iframe.style.display = 'flex';
      iframe.style.position = 'fixed';
      iframe.style.top = '0';
      iframe.style.left = '0';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = 'none';
      iframe.style['z-index'] = '1000000000';
      // iframe.style.opacity = '0';
      // iframe.style['pointer-events'] = 'none';

      document.body.appendChild(iframe);
    } catch (e) {
      this.options.onError && this.options.onError(e);
    }
  }

  showIframe(show) {
    this.iframe.style.display = show ? 'flex' : 'none';
  }

  getSigner() {
    return this.ethersWallet || this.defaultProvider;
  }

  async getERC20Contract(asset) {
    const erc20Abi = await import('./abis/erc20.json');
    return new this.ethers.Contract(
      TOKEN_CONTRACT_ADDRESSES[asset],
      erc20Abi,
      this.getSigner()
    );
  }

  async getUniswapRouterV2Contract() {
    const uniswapRouterV2Abi = await import('./abis/uniswap_router_v2.json');
    return new this.ethers.Contract(
      UNISWAP_ROUTER_V2_ADDRESS,
      uniswapRouterV2Abi,
      this.getSigner()
    );
  }

  async getOneSplitContract() {
    const oneSplitAbi = await import('./abis/onesplit.json');
    return new this.ethers.Contract(
      ONE_SPLIT_ADDRESS,
      oneSplitAbi,
      this.getSigner()
    );
  }

  // events from js

  onError(sid, payload) {
    this.options.onError(new Error(payload));
  }

  onCancel() {
    this.close();
    this.options.onCancel && this.options.onCancel();
  }

  toFixed(a, b) {
    if (this.isZero(bign(a)) || this.isZero(bign(b))) {
      return '0';
    }
    return bign(a.toString())
      .div(bign(b.toString()))
      .toFixed(PRECISION);
  }

  formatUnits(a, decimals) {
    return this.toFixed(a.toString(), bign(10).pow(decimals));
  }

  isZero(a) {
    return a.eq(bign('0'));
  }

  // bn.js
  bn(a) {
    return this.ethers.BigNumber.from(a.toString());
  }

  async onIframeLoad(sid) {
    const { ethers } = await import('ethers');
    this.ethers = ethers;
    this.defaultProvider = new this.ethers.providers.InfuraProvider(
      'homestead',
      INFURA_ID
    );

    this.postMessageToIframe(sid, 'iframe-load', {});
  }

  async onConnectWallet(sid) {
    const { default: Web3Modal } = await import('web3modal');
    const { default: MewConnect } = await import(
      '@myetherwallet/mewconnect-web-client'
    );
    const { default: WalletConnectProvider } = await import(
      '@walletconnect/web3-provider'
    );

    this.showIframe(false);

    const web3Modal = new Web3Modal({
      cacheProvider: true,
      providerOptions: {
        mewconnect: {
          package: MewConnect,
          options: {
            infuraId: INFURA_ID,
          },
        },
        walletconnect: {
          package: WalletConnectProvider,
          options: {
            infuraId: INFURA_ID,
          },
        },
      },
    });
    this.web3Provider = await web3Modal.connect();
    this.web3Provider.on('accountsChanged', () => {});
    this.web3Provider.on('chainChanged', () => {});

    this.ethersProvider = new this.ethers.providers.Web3Provider(
      this.web3Provider
    );
    this.ethersWallet = this.ethersProvider.getSigner();

    const address = (this.address = await this.ethersWallet.getAddress());
    this.postMessageToIframe(sid, 'connect', { address });
    this.showIframe(true);
  }

  async onGetQuote(sid, { fromAsset, usd: usdAmount }) {
    const fromPAN = fromAsset === 'PAN';
    const fromETH = fromAsset === 'ETH';

    let fromAssetBalance;
    let fromAssetAmount;
    let toPanAmount;
    let fromAssetContract;

    if (this.address) {
      if (fromETH) {
        fromAssetBalance = await this.ethersWallet.getBalance();
      } else {
        fromAssetContract = await this.getERC20Contract(fromAsset);
        fromAssetBalance = await fromAssetContract.balanceOf(this.address);
      }
    }
    if (fromPAN) {
      const {
        [COIN_GECKO_IDS.PAN]: { usd: panPrice },
      } = await request(
        `https://api.coingecko.com/api/v3/simple/price?ids=${COIN_GECKO_IDS.PAN}&vs_currencies=usd`
      );

      fromAssetAmount = toPanAmount = bign(usdAmount)
        .mul(Math.pow(10, 18))
        .div(bign(panPrice));
    } else {
      const fromAssetId = COIN_GECKO_IDS[fromAsset];
      const {
        [fromAssetId]: { usd: fromAssetPrice },
      } = await request(
        `https://api.coingecko.com/api/v3/simple/price?ids=${fromAssetId}&vs_currencies=usd`
      );

      fromAssetAmount = this.ethers.utils.parseEther(
        bign(usdAmount)
          .div(bign(fromAssetPrice))
          .toFixed(PRECISION)
      );
      debug('d %s', fromAssetAmount.toString());
      // const uniswapRouterV2Contract = await this.getUniswapRouterV2Contract();
      // [
      //   fromAssetAmount,
      //   toPanAmount,
      // ] = await uniswapRouterV2Contract.getAmountsOut(estimateFromAssetAmount, [
      //   TOKEN_CONTRACT_ADDRESSES[fromETH ? 'WETH' : fromAsset],
      //   TOKEN_CONTRACT_ADDRESSES.PAN,
      // ]);

      const oneSplitContract = await this.getOneSplitContract();
      const quote = await oneSplitContract.getExpectedReturnWithGas(
        fromETH ? ETH_ONE_INCH_ADDR : TOKEN_CONTRACT_ADDRESSES[fromAsset],
        TOKEN_CONTRACT_ADDRESSES.PAN,
        fromAssetAmount,
        100,
        0,
        0
      );
      toPanAmount = quote.returnAmount;

      debug('c %s %s', toPanAmount.toString(), fromAssetAmount.toString());
    }

    // fromAssetBalance = fromAssetBalance && bign(fromAssetBalance.toString());

    const hasSufficientBalance =
      fromAssetBalance &&
      fromAssetAmount &&
      fromAssetBalance.gte(fromAssetAmount);

    const approve =
      !fromPAN &&
      fromAssetContract &&
      fromAssetAmount &&
      fromAssetAmount.gt(
        await fromAssetContract.allowance(
          this.address,
          UNISWAP_ROUTER_V2_ADDRESS
        )
      );

    this.postMessageToIframe(sid, 'get-quote', {
      toPanAmount: toPanAmount && this.formatUnits(toPanAmount, 18),
      fromAssetAmount: fromAssetAmount && this.formatUnits(fromAssetAmount, 18),
      fromAssetBalance:
        fromAssetBalance && this.formatUnits(fromAssetBalance, 18),
      approve,
      hasSufficientBalance,
    });
  }

  async onApprove(sid, { fromAsset, fromAssetAmount }) {
    fromAssetAmount = this.ethers.utils
      .parseUnits(fromAssetAmount.toString(), 18)
      .mul(101)
      .div(100);

    const fromAssetContract = await this.getERC20Contract(fromAsset);
    try {
      const tx = await fromAssetContract.approve(
        UNISWAP_ROUTER_V2_ADDRESS,
        fromAssetAmount
      );
      await tx.wait();
      this.postMessageToIframe(sid, 'approve');
    } catch (err) {
      debug('error %s', err.message);
      this.postMessageToIframe(sid, 'error', err);
    }
  }

  async onDonate(sid, { fromAsset, fromAssetAmount, toPanAmount, toAddress }) {
    // all assets involved have a decimal of 18
    fromAssetAmount = this.ethers.utils.parseEther(fromAssetAmount.toString());
    toPanAmount = this.ethers.utils.parseEther(toPanAmount.toString());

    const fromPAN = fromAsset === 'PAN';
    const fromETH = fromAsset === 'ETH';

    try {
      let tx;

      if (fromPAN) {
        const panContract = await this.getERC20Contract('PAN');
        tx = await panContract.transfer(toAddress, fromAssetAmount);
      } else {
        const uniswapRouterV2Contract = await this.getUniswapRouterV2Contract();
        if (fromETH) {
          tx = await uniswapRouterV2Contract.swapETHForExactTokens(
            toPanAmount, // amountOut
            [TOKEN_CONTRACT_ADDRESSES.WETH, TOKEN_CONTRACT_ADDRESSES.PAN],
            toAddress,
            deadline(),
            { value: fromAssetAmount }
          );
        } else {
          // DAI
          tx = await uniswapRouterV2Contract.swapTokensForExactTokens(
            toPanAmount, // amountOut
            fromAssetAmount, // amountInMax
            [TOKEN_CONTRACT_ADDRESSES[fromAsset], TOKEN_CONTRACT_ADDRESSES.PAN],
            toAddress,
            deadline()
          );
        }
      }

      this.postMessageToIframe(sid, 'donate', {
        transactionHash: tx.hash,
      });
    } catch (err) {
      debug('error %s', err.message);
      this.postMessageToIframe(sid, 'error', err);
    }
  }

  onComplete(sid, { transactionHash }) {
    if (this.options.onDonate) {
      this.options.onDonate(transactionHash);
    } else {
      this.close();
    }
  }
}

async function request(url) {
  return await (await fetch(url)).json();
}

function deadline() {
  const now = new Date();
  const utcMilllisecondsSinceEpoch =
    now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  return (
    UNISWAP_DEADLINE_MINUTES * 60 +
    Math.round(utcMilllisecondsSinceEpoch / 1000)
  );
}

window.panvala = function(options) {
  debug('donate');
  const donate = new Donate(options);
  return () => donate.close.call(donate);
};
