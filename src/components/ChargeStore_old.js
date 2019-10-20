// @flow
import { observable, computed, action, toJS } from 'mobx'
import { publicClient } from 'api/PublicClient'
import isEqual from 'lodash/isEqual'

import type { Address, Charge, OrderCode, Payment, Network, TxId } from 'api/models'
import type { CryptoCurrency, CryptoMoney, ExchangeRate } from 'api/money'
import { NETWORKS_BY_CURRENCY } from 'api/money'
import { TrackingStore } from './TrackingStore'
import { widgetStore } from 'stores/WidgetStore'
import { IS_LOCAL_STORAGE_AVAILABLE } from 'utils/localStores'
import { commerceConfig } from 'utils/config'
import { CURRENCIES_BY_NETWORK, contractInfo } from 'utils/currencies'
import { ERC20_GAS_LIMIT, encodeErc20Transfer } from 'utils/erc20'
import { saveStore, loadStore } from 'utils/localStores'
import { setTrackingUserId, setUserProperty } from 'utils/tracking'

/// Implemented by CheckoutStore.
export interface ChargeParent {
  trackingStore(): TrackingStore;
  returnHome(): void;
}

const EXPIRATION_TIME = 3600 // one hour
const POLL_ERROR_THRESHOLD = 3 // repeated poll failures show an error
const COINBASE_USD_UPPER_SEND_LIMIT = 1000
export const COINBASE_CRYPTO_LOWER_SEND_LIMIT = {
  BTC: 0.0001,
  BCH: 0.00001,
  LTC: 0.001,
  ETH: 0.001,
  USDC: 0.001,
  BEER: 0.001,
  TST: 0.001,
}

export type ChargeStep =
  | 'networkPicker'
  | 'oauth'
  | 'awaitingPayment'
  | 'pendingPayment'
  | 'waitingForConfirmations'
  | 'successfulPayment'
  | 'failedPayment'
  | 'canceledPayment'
  | 'processingCancellation'
  | 'maintenance'

export type PollStatus = 'polling' | 'stopped' | 'error'

type Web3Status =
  | {| which: 'idle' |}
  | {| which: 'asking' |}
  | {| which: 'declined', currency: CryptoCurrency |}
  | {| which: 'submitted', txId: TxId |}
  | {| which: 'mined', txId: TxId, confirmations: number |}
  | {| which: 'canceled' |}
  | {| which: 'failed' |}
  | {| which: 'unsupported' |}
  | {| which: 'wrong-chain' |}
  | {| which: 'no-account' |}

type PwcbErrorKey = 'oauth' | 'yubikey' | 'insufficientFunds' | 'chargeBelowLimit' | 'chargeOverLimit'
export type PwcbError = {|
  title: string,
  message: string,
  id: PwcbErrorKey,
|}
type PwcbErrors = {[PwcbErrorKey]: PwcbError}
const pwcbErrors: PwcbErrors = {
  oauth: {
    id: 'oauth',
    title: 'Checkout Error',
    message: `YubiKey authentication is currently unsupported for Pay with Coinbase.`,
  },
  chargeOverLimit: {
    id: 'chargeOverLimit',
    title: 'Charge Error',
    message: 'The price of this item is greater than the maximum send amount on Coinbase.',
  },
  chargeBelowLimit: {
    id: 'chargeBelowLimit',
    title: 'Charge Error',
    message: 'The price of this item is less than the minimum send amount on Coinbase.',
  },
  yubikey: {
    id: 'yubikey',
    title: 'Authentication Error',
    message: 'YubiKey authentication is currently unsupported for Pay with Coinbase.',
  },
  insufficientFunds: {
    id: 'insufficientFunds',
    title: 'Insufficient Funds',
    message: 'You do not have sufficient funds in your Coinbase account. Please choose another payment option.',
  },
}

export const shouldShowPayWithCoinbase = (charge: Charge): boolean => (
  charge.pricingType !== 'no_price' && // not donations
  IS_LOCAL_STORAGE_AVAILABLE // has localStorage (false for private mode in Safari)
)

class ChargeStore {
  @observable charge: Charge
  @observable step: ChargeStep
  @observable pickedNetwork: ?Network
  @observable now: number = Date.now() / 1000
  @observable web3Status: Web3Status = { which: 'idle' }
  @observable pollErrorStreak: number = 0
  /// the fadeIn/fadeOut states trigger CSS animations
  /// the `null` state removes the QR modal & canvas from the React hierarchy completely,
  /// which fixes integration testing & helps performance
  @observable qr: null | 'fadeIn' | 'fadeOut' = null

  parent: ChargeParent
  tracking: TrackingStore
  usdChargeAmount: number
  isChargeBelowCoinbaseLowerSendLimit: boolean
  isPwcbEnabled: boolean = true
  pwcbError: ?PwcbError = null
  pollTimeoutId: ?TimeoutID = null
  expiryIntervalId: ?IntervalID = null
  isOAuthPayment: boolean = false

  @action
  setCharge(charge: Charge, usdExchangeRate: ?ExchangeRate, pickedNetwork: ?Network, parent: ChargeParent) {
    setTrackingUserId(charge.code)
    setUserProperty('charge_pricing_type', charge.pricingType)
    this.charge = charge
    this.parent = parent
    this.tracking = parent.trackingStore()
    this.web3Status = { which: 'idle' }
    this.setIsChargeBelowCoinbaseLowerSendLimit()
    if (usdExchangeRate) {
      this.setUsdChargeAmount(usdExchangeRate)
    }
    if (pickedNetwork) {
      this.pickedNetwork = pickedNetwork
      this.step = 'awaitingPayment'
    } else {
      // For Pay with Coinbase, determines if
      // charge amount exeeds upper or lower send limits.
      if (this.isChargeBelowCoinbaseLowerSendLimit) {
        this.setPwcbEnabled(false, 'chargeBelowLimit')
      } else if (this.isChargeAboveCoinbaseUpperSendLimit) {
        this.setPwcbEnabled(false, 'chargeOverLimit')
      }
      this.showNetworkPicker()
    }
    this.startPolling()
    this.processChargeUpdate(charge, 'startup')
    // TODO: revise this hack for overriding success state fix on local refresh
    // https://coinbase.atlassian.net/browse/API-2169
    this.loadLocalStoreCharge()
  }

  @action
  saveLocalStoreCharge(data: {isOAuthPayment: boolean}) {
    saveStore(this.charge.code, data)
    this.isOAuthPayment = data.isOAuthPayment
  }

  @action
  loadLocalStoreCharge() {
    const {code, timeline} = this.charge
    const state = loadStore(code)
    if (state?.isOAuthPayment) {
      this.isOAuthPayment = true
      // Only show certain states for coinbase payments
      switch (this.chargeStatus) {
        case 'UNRESOLVED':
          // overpaid, underpaid, delayed
          // (this should never happen)
          this.showFailedPayment()
          break
        case 'RESOLVED':
        case 'COMPLETED':
        default:
          this.showSuccessfulPayment()
          break
      }
    }
  }

  setUsdChargeAmount(baseExcahngeRate: ExchangeRate) {
    // Set USD amount using exchange rate conversion (local => USD)
    const {to, from} = baseExcahngeRate
    const fromRate = Number(from.amount)
    const toRate = Number(to.amount)
    const currencyRate = Number(this.charge.pricing.local.amount)
    this.usdChargeAmount = toRate * currencyRate / fromRate
  }

  setIsChargeBelowCoinbaseLowerSendLimit() {
    // Do not set limits for donations
    if (this.isUnpriced) {
      return
    }
    // Filter charge currencies lower than the coinbase minimum send limit
    const {charge} = this
    const invalidCurrencies = []
    for (let key in charge.addresses) {
      const {amount, currency} = charge.pricing[key]
      const limitAmount = Number(COINBASE_CRYPTO_LOWER_SEND_LIMIT[currency] || 0)
      const priceAmount = Number(amount)
      if (priceAmount < limitAmount) {
        invalidCurrencies.push(currency)
      }
    }
    // Set truthy if all currencies on the network are invalid
    this.isChargeBelowCoinbaseLowerSendLimit = invalidCurrencies.length === Object.keys(charge.addresses).length
  }
  get isChargeAboveCoinbaseUpperSendLimit() {
    return this.usdChargeAmount > COINBASE_USD_UPPER_SEND_LIMIT
  }

  chargeInStore(code: OrderCode) {
    return this.charge && this.charge.code === code
  }

  @computed
  get activePayment(): ?Payment {
    return this.charge.payments[0]
  }

  @computed
  get secondsToExpiration(): number {
    if (this.charge) {
      const expiresAt = Date.parse(this.charge.expiresAt) / 1000
      return Math.max(0, expiresAt - this.now)
    }
    return 0
  }

  @computed
  get timeToExpiration(): string {
    const { secondsToExpiration } = this
    const min = Math.floor(secondsToExpiration / 60)
    const sec = parseInt(secondsToExpiration - min * 60, 10)
    const zero = sec < 10 ? '0' : ''
    return `${min}:${zero}${sec}`
  }

  @computed
  get pollDelay(): number {
    if (this.step === 'networkPicker' || this.step === 'maintenance' || document.hidden) {
      return 15000
    }
    // go easy after repeated failures
    if (this.pollErrorStreak > 10) {
      return 10000
    }
    if (this.pollErrorStreak > 5) {
      return 5000
    }
    // normal poll is 2sec
    return 2000
  }

  @computed
  get pollStatus(): PollStatus {
    if (this.pollErrorStreak > POLL_ERROR_THRESHOLD) {
      return 'error'
    }
    return this.pollTimeoutId ? 'polling' : 'stopped'
  }

  @computed
  get expirationPercentage(): number {
    return (
      ((EXPIRATION_TIME - this.secondsToExpiration) / EXPIRATION_TIME) * 100
    )
  }

  @computed
  get shouldSkipNetworkPicker(): boolean {
    return !shouldShowPayWithCoinbase(this.charge) && this.networks.length === 1
  }

  @computed
  get isUnpriced(): boolean {
    return this.charge.pricingType !== 'fixed_price'
  }

  @computed
  get canCancelCharge(): boolean {
    const { charge } = this
    if (!charge || !charge.cancelUrl) {
      return false
    }
    // are there any states like PENDING or FAILED etc?
    const nonNewState = this.charge.timeline.find(t => t.status !== 'NEW')
    // if there are, we can no longer cancel
    return !nonNewState
  }

  @computed
  get networks(): Array<Network> {
    /// Object.keys returns a string array, even though this.charge.addresses
    /// only has Network keys
    return ((Object.keys(this.charge.addresses): any): Array<Network>).sort()
  }

  /* Actions */

  @action
  goBack = () => {
    switch (this.step) {
      case 'awaitingPayment':
        if (this.shouldSkipNetworkPicker) {
          this.stopPolling()
          this.parent.returnHome()
        } else {
          this.showNetworkPicker()
        }
        break

      case 'networkPicker':
      case 'successfulPayment':
      case 'failedPayment':
      case 'canceledPayment':
        this.stopPolling()
        this.parent.returnHome()
        break

      case 'pendingPayment':
      case 'waitingForConfirmations':
      case 'processingCancellation':
      default:
        throw new Error("can't go back from " + this.step)
    }
  }

  @action
  pickNetwork = (network: Network) => {
    this.tracking.track('checkout:currency-picked')
    this.showAwaitingPayment(network)
  }

  @action
  payWithCoinbase = () => {
    this.stopPolling();
    this.showOAuthScreen();
  }

  @action
  requestWeb3 = async () => {
    const { ethereum } = window
    if (!ethereum) {
      this.web3Status = { which: 'unsupported' }
      return
    }
    // web3 requires that we specify a price
    if (this.isUnpriced) {
      return
    }
    const network = this.pickedNetwork
    const currency = network && CURRENCIES_BY_NETWORK[network]
    if (!network || !currency) {
      return
    }
    // is this ETH-based?
    const erc20 = contractInfo(currency)
    if (network !== 'ethereum' && !erc20) {
      return
    }
    // make sure we haven't already asked them; don't want to spam
    const { web3Status } = this
    if (web3Status.which !== 'idle') {
      if (web3Status.which === 'declined' && web3Status.currency !== currency) {
        // they declined a different currency; let them try this one
      } else {
        // already went through the flow; don't ask again
        return
      }
    }

    const to: ?Address = this.charge.addresses[network]
    const price: ?CryptoMoney = this.charge.pricing ? this.charge.pricing[network] : null
    if (!to || !price) {
      return
    }
    // OK let's start loading the web3 library in the BG
    const web3Promise = import(/* webpackChunkName: "web3" */ 'web3')

    // ask if it's OK to connect
    this.web3Status = { which: 'asking' }
    try {
      await ethereum.enable()
    } catch (e) {
      this.web3Status = { which: 'declined', currency }
      return
    }
    // try to connect
    let Web3
    try {
      Web3 = (await web3Promise).default
    } catch (e) {
      console.error('import web3', e)
      this.web3Status = { which: 'failed' }
      return
    }
    const web3 = new Web3(ethereum)
    const { toHex, toWei } = web3.utils
    // ensure we're on homestead or ropsten as required
    let desiredChainId
    if (erc20) {
      desiredChainId = erc20.network === 'ropsten' ? 3 : 1
    } else {
      desiredChainId = parseInt(commerceConfig.ETH_CHAIN_ID, 10) || 1
    }
    try {
      const chainIdWeb3 = await web3.eth.getChainId()
      if (chainIdWeb3 !== desiredChainId) {
        console.warn('web3: wrong chain id', chainIdWeb3)
        this.web3Status = { which: 'wrong-chain' }
        return
      }
    } catch (e) {
      console.error('web3', e)
      this.web3Status = { which: 'failed' }
      return
    }
    // alright let's send some money
    let events
    try {
      const addresses = await web3.eth.getAccounts()
      if (!addresses || !addresses.length) {
        this.web3Status = { which: 'no-account' }
        return
      }
      const from = addresses[0]

      let tx
      if (erc20) {
        const data = encodeErc20Transfer(to, price)
        const gas = ERC20_GAS_LIMIT
        tx = { from, to: erc20.address, data, gas }
      } else {
        // plain ETH transfer
        const { amount } = price
        const value = toHex(toWei(amount, 'ether'))
        tx = { from, to, value }
      }
      events = web3.eth.sendTransaction(tx)
    } catch (e) {
      console.error('web3', e)
      this.web3Status = { which: 'declined', currency }
      return
    }

    // transaction was created; monitor it
    events
      .on('transactionHash', txId => {
        // for some reason I've seen Metamask pass a result here even if denied???
        if (!txId) {
          this.web3Status = { which: 'declined', currency }
        } else {
          this.web3Status = { which: 'submitted', txId }
        }
      })
      .on('receipt', receipt => {
        const { web3Status } = this
        if (receipt.status === false) {
          this.web3Status = { which: 'failed' }
        } else if (web3Status.which === 'submitted') {
          const { txId } = web3Status
          this.web3Status = { which: 'mined', txId, confirmations: 0 }
        }
      })
      .on('confirmation', (confirmations, receipt) => {
        if (this.web3Status.which !== 'declined') {
          const txId = receipt.transactionHash
          this.web3Status = { which: 'mined', txId, confirmations }
        }
      })
      .on('error', error => {
        console.error('web3 tx error', error)
        this.web3Status = { which: 'declined', currency }
      })
  }

  /// this doesn't actually cancel anything except the local progress screen
  @action
  cancelWeb3 = () => {
    this.web3Status = { which: 'canceled' }
  }

  @action
  startPolling = () => {
    this.stopPolling()
    this.poll(true)

    this.now = Date.now() / 1000
    this.expiryIntervalId = setInterval(() => {
      this.now = Date.now() / 1000
    }, 1000)
  }

  @action
  stopPolling = () => {
    if (this.pollTimeoutId) {
      clearTimeout(this.pollTimeoutId)
      this.pollTimeoutId = null
    }
    if (this.expiryIntervalId) {
      clearInterval(this.expiryIntervalId)
      this.expiryIntervalId = null
    }
    this.pollErrorStreak = 0
  }

  @action
  processPendingPayment = () => {
    const payment = this.activePayment
    if (!payment) {
      return
    }
    if (payment.block.confirmationsRequired <= payment.block.confirmations) {
      this.showSuccessfulPayment()
    } else if (payment.block.confirmations === 0) {
      this.showPendingPayment()
    } else {
      this.showWaitingForConfirmations()
    }
  }

  @action
  setPwcbEnabled: Function = (isEnabled: boolean, errorKey: PwcbErrorKey) => {
    this.isPwcbEnabled = isEnabled
    this.pwcbError = pwcbErrors[errorKey]
  }

  @action
  showNetworkPicker = () => {
    this.pickedNetwork = null
    if (this.shouldSkipNetworkPicker) {
      // If there is only 1 network, then don't show the network picker
      this.showAwaitingPayment(this.networks[0])
    } else {
      this.step = 'networkPicker'
    }
  }

  @action
  showOAuthScreen = () => {
    this.step = 'oauth'
  }

  @action
  showAwaitingPayment = (network: Network) => {
    this.pickedNetwork = network
    this.tracking.track('checkout:awaiting-payment-shown')
    this.step = 'awaitingPayment'
    this.startPolling()
  }

  @action
  showPendingPayment = () => {
    this.tracking.track('checkout:payment-detected')
    this.step = 'pendingPayment'

    // inform payment button, if any, of payment detection
    widgetStore.sendPaymentDetectedEvent(this.charge.code)
  }

  @action
  showWaitingForConfirmations = () => {
    this.tracking.track('checkout:payment-waiting-for-confirmations')
    this.step = 'waitingForConfirmations'
  }

  @action
  showSuccessfulPayment = () => {
    this.tracking.track('checkout:payment-completed')
    this.step = 'successfulPayment'
    this.stopPolling()
    // inform payment button, if any, of charge success
    widgetStore.sendSuccessfulChargeEvent(this.charge.code)
  }

  @action
  showFailedPayment = () => {
    this.tracking.track('checkout:payment-failed')

    // inform payment button, if any, of charge failure
    widgetStore.sendFailedChargeEvent(this.charge.code)

    this.step = 'failedPayment'
    this.stopPolling()
  }

  @action
  showCanceledPayment = () => {
    this.tracking.track('checkout:payment-canceled')

    // inform payment button, if any, of charge failure
    widgetStore.sendFailedChargeEvent(this.charge.code)

    this.step = 'canceledPayment'
    this.stopPolling()
  }

  @action
  showMaintenanceMode = () => {
    this.step = 'maintenance'
    // we'll keep polling; maybe the API will come back?
  }

  get chargeStatus() {
    const {timeline} = this.charge
    return timeline[timeline.length - 1]?.status
  }

  /*
   * Conditionally update the charge object.
   * If there are changes to process, use the charge's
   * status to determine which screen should be shown.
   */
  @action
  processChargeUpdate = (charge: Charge, context: 'poll' | 'startup' | 'cancel') => {
    // if we got the same object as last poll, bail right away
    if (context === 'poll' && isEqual(toJS(this.charge), charge)) {
      return
    }

    this.charge = charge
    const status = this.chargeStatus
    switch (status) {
      case 'NEW':
        // still waiting for a payment
        // note: We used to check for payment expiry here via `secondsToExpiration < 0`.
        //       However, this resulted in us showing a "transaction was not processed properly" screen
        //       to customers who had simply gone offline or closed their laptop.
        //       Instead of guessing incorrectly, let's wait for the actual EXPIRED status from the API.
        break
      case 'PENDING':
        // a transaction was detected.
        // if this is an unpriced charge, confirm instantly.
        if (this.isUnpriced) {
          this.showSuccessfulPayment()
        } else {
          this.processPendingPayment()
        }
        break
      case 'COMPLETED':
        this.showSuccessfulPayment()
        break
      case 'RESOLVED':
        this.showSuccessfulPayment()
        break
      case 'UNRESOLVED':
        // overpaid, underpaid, delayed
        this.showFailedPayment()
        break
      case 'EXPIRED':
        this.showFailedPayment()
        break
      case 'CANCELED':
        this.showCanceledPayment()
        break
      default:
      // no-op
    }
  }

  @action
  poll = async (isInitial: boolean = false) => {
    if (!this.charge) {
      // Cannot start polling when there's no charge
      return
    }
    // We are already awaiting poll()
    if (this.pollTimeoutId && isInitial) {
      console.warn('poll: already in a poll state')
      return
    }
    // We set pollTimeoutId to be truthy here so any subsequent API
    // requests are blocked by the above check until the await has responded.
    this.pollTimeoutId = setTimeout(() => {})

    try {
      const charge = await publicClient.getChargeFromOrderCode(this.charge.code)
      // polling might have been cancelled by now
      if (!this.pollTimeoutId) {
        return
      }
      this.pollErrorStreak = 0
      this.processChargeUpdate(charge, 'poll')
      // trigger the next poll
      this.pollTimeoutId = setTimeout(this.poll, this.pollDelay)
    } catch (e) {
      // polling might have been cancelled by now
      if (!this.pollTimeoutId) {
        return
      }
      if (e.statusCode === 503 && e.type === 'maintenance') {
        this.showMaintenanceMode()
      } else {
        console.error('poll', e)
        this.pollErrorStreak++
      }
      // trigger the next poll
      this.pollTimeoutId = setTimeout(this.poll, this.pollDelay)
    }
  }

  @action
  cancelCharge = async (): Promise<?string> => {
    if (!this.charge) {
      return
    }
    this.tracking.track('checkout:payment-canceled')
    this.step = 'processingCancellation'
    this.stopPolling()
    try {
      const charge = await publicClient.cancelCharge(this.charge.code)
      this.processChargeUpdate(charge, 'cancel')
    } catch (err) {
      console.error('cancel failed with ' + err)
      /*
      Errors fall in the following categories and below is the explanation as to why we ignore them.
      4xx:
        This means the charge was not in the correct state (i.e. New)
        and as such cannot be canceled. The charge was already processed
        in some other way and can only be resolved via dashboard/or admin.
        No user interaction required.
      5xx and others:
        This means our server had an error or there was a network error.
        In either case, there is no possible recovery that needs the user's attention.

      We can safely ignore all these errors, as the charge will simply continue to exist and
        the user will see it on refresh as it still exists in the local browser cache.
      */
    }
    return this.charge.cancelUrl
  }
}

const chargeStore = new ChargeStore()

export { chargeStore as ChargeStore }
