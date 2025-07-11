import { ethers } from 'ethers'

interface BridgeConfig {
  network?: 'mainnet' | 'testnet'
  walrusPublisherUrl?: string
  walrusAggregatorUrl?: string
  suiRecipientAddress?: string
  circleAttestationUrl?: string
}

interface StorageResult {
  success: boolean
  blobId?: string
  suiObjectId?: string
  walrusUrl?: string
  bridgeTxHash?: string
  attestationHash?: string
  error?: string
}

interface WalrusStorageResponse {
  newlyCreated?: {
    blobObject: {
      id: string
      blobId: string
      storage: {
        id: string
        startEpoch: string
        endEpoch: string
        storageSize: string
      }
    }
    resourceOperation: {
      RegisteredBlobObject?: any
    }
  }
  alreadyCertified?: {
    blobId: string
    event: {
      txDigest: string
      eventSeq: string
    }
    endEpoch: string
  }
}

const CCTP_CONTRACTS = {
  mainnet: {
    ethereum: {
      TOKEN_MESSENGER: '0xbd3fa81b58ba92a82136038b25adec7066af3155',
      MESSAGE_TRANSMITTER: '0x0a992d191deec32afe36203ad87d7d289a738f81',
      USDC_TOKEN: '0xa0b86a33e6ba9c6c088d3e1afa2beea6fd0d9b4f',
      DOMAIN_ID: 0
    },
    arbitrum: {
      TOKEN_MESSENGER: '0x19330d10d9cc8751218eaf51e8885d058642e08a',
      MESSAGE_TRANSMITTER: '0xc30362313fbba5cf9163f0bb16a0e01f01a896ca',
      USDC_TOKEN: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      DOMAIN_ID: 3
    },
    base: {
      TOKEN_MESSENGER: '0x1682ae6375c4e4a97e4b583bc394c861a46d8962',
      MESSAGE_TRANSMITTER: '0xad09780d7a6d4d4b7b90f88baad9b1a0d44bd9f4',
      USDC_TOKEN: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      DOMAIN_ID: 6
    },
    avalanche: {
      TOKEN_MESSENGER: '0x6b25532e1060ce10cc3b0a99e5683b91bfde6982',
      MESSAGE_TRANSMITTER: '0x8186359af5f57fbb40c6b14a588d2a59c0c29880',
      USDC_TOKEN: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      DOMAIN_ID: 1
    },
    optimism: {
      TOKEN_MESSENGER: '0x2b4069517957735be00cee0fadaea114a8124c0a',
      MESSAGE_TRANSMITTER: '0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8',
      USDC_TOKEN: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      DOMAIN_ID: 2
    },
    polygon: {
      TOKEN_MESSENGER: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
      MESSAGE_TRANSMITTER: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
      USDC_TOKEN: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      DOMAIN_ID: 7
    }
  },
  testnet: {
    ethereum_sepolia: {
      TOKEN_MESSENGER: '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
      MESSAGE_TRANSMITTER: '0x7865fafc2db2093669d92c0f33aeef291086befd',
      USDC_TOKEN: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      DOMAIN_ID: 0
    },
    arbitrum_sepolia: {
      TOKEN_MESSENGER: '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
      MESSAGE_TRANSMITTER: '0xaCF1ceeF35caAc005e15888dDb8A3515C41B4872',
      USDC_TOKEN: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      DOMAIN_ID: 3
    }
  }
}

const SUI_DOMAIN_ID = 5

const WALRUS_ENDPOINTS = {
  mainnet: {
    publisher: 'https://publisher.walrus.space',
    aggregator: 'https://aggregator.walrus.space'
  },
  testnet: {
    publisher: 'https://publisher.walrus-testnet.walrus.space',
    aggregator: 'https://aggregator.walrus-testnet.walrus.space'
  }
}

const CIRCLE_ATTESTATION_URLS = {
  mainnet: 'https://iris-api.circle.com',
  testnet: 'https://iris-api-sandbox.circle.com'
}

export class EthWalrusBridge {
  private config: BridgeConfig
  private network: 'mainnet' | 'testnet'
  private walrusPublisher: string
  private walrusAggregator: string
  private circleAttestationUrl: string
  private suiRecipient: string

  constructor(config: BridgeConfig = {}) {
    this.config = config
    this.network = config.network || 'testnet'
    this.walrusPublisher = config.walrusPublisherUrl || WALRUS_ENDPOINTS[this.network].publisher
    this.walrusAggregator = config.walrusAggregatorUrl || WALRUS_ENDPOINTS[this.network].aggregator
    this.circleAttestationUrl = config.circleAttestationUrl || CIRCLE_ATTESTATION_URLS[this.network]
    this.suiRecipient = config.suiRecipientAddress || '0x7b005829a1305a3ebeea7cff0dd200bbe7e2f42d1adce0d9045dd57ef12f52c9'
  }

  async storeOnWalrus(data: any, epochs: number = 5): Promise<StorageResult> {
    try {
      let blob: Buffer
      if (Buffer.isBuffer(data)) {
        blob = data
      } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        blob = Buffer.from(data)
      } else if (typeof data === 'string') {
        blob = Buffer.from(data, 'utf8')
      } else {
        blob = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      try {
        const response = await fetch(
          `${this.walrusPublisher}/v1/blobs?epochs=${epochs}`,
          {
            method: 'PUT',
            body: blob,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': blob.length.toString()
            },
            signal: controller.signal
          }
        )

        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Walrus storage failed: ${response.status} - ${errorText}`)
        }

        const result: WalrusStorageResponse = await response.json()

        if (result.newlyCreated) {
          const blobInfo = result.newlyCreated.blobObject
          return {
            success: true,
            blobId: blobInfo.blobId,
            suiObjectId: blobInfo.id,
            walrusUrl: `${this.walrusAggregator}/v1/blobs/${blobInfo.blobId}`
          }
        } else if (result.alreadyCertified) {
          return {
            success: true,
            blobId: result.alreadyCertified.blobId,
            suiObjectId: result.alreadyCertified.event.txDigest,
            walrusUrl: `${this.walrusAggregator}/v1/blobs/${result.alreadyCertified.blobId}`
          }
        }

        throw new Error('Unexpected Walrus response format')

      } catch (error: any) {
        clearTimeout(timeoutId)
        if (error.name === 'AbortError') {
          throw new Error('Walrus storage timeout')
        }
        throw error
      }

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  async bridgeAndStore(
    signer: ethers.Signer,
    data: any,
    usdcAmount: string = "1.0",
    sourceChain: string = 'arbitrum'
  ): Promise<StorageResult> {
    try {
      const chainConfig = CCTP_CONTRACTS[this.network]?.[sourceChain]
      if (!chainConfig) {
        throw new Error(`Unsupported chain: ${sourceChain} on ${this.network}`)
      }

      const storageResult = await this.storeOnWalrus(data)
      if (!storageResult.success) {
        return storageResult
      }

      const bridgeResult = await this.bridgeUSDCViaCCTP(signer, usdcAmount, sourceChain)
      
      return {
        success: true,
        blobId: storageResult.blobId,
        suiObjectId: storageResult.suiObjectId,
        walrusUrl: storageResult.walrusUrl,
        bridgeTxHash: bridgeResult.success ? bridgeResult.txHash : undefined,
        attestationHash: bridgeResult.success ? bridgeResult.attestationHash : undefined,
        error: bridgeResult.success ? undefined : `Storage succeeded but bridge failed: ${bridgeResult.error}`
      }

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  private async bridgeUSDCViaCCTP(
    signer: ethers.Signer, 
    amount: string,
    sourceChain: string
  ): Promise<{
    success: boolean
    txHash?: string
    attestationHash?: string
    error?: string
  }> {
    try {
      const chainConfig = CCTP_CONTRACTS[this.network][sourceChain]
      const amountInUnits = ethers.parseUnits(amount, 6)

      const usdcContract = new ethers.Contract(
        chainConfig.USDC_TOKEN,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function approve(address spender, uint256 amount) returns (bool)',
          'function allowance(address owner, address spender) view returns (uint256)'
        ],
        signer
      )

      const userAddress = await signer.getAddress()
      const balance = await usdcContract.balanceOf(userAddress)
      
      if (balance < amountInUnits) {
        throw new Error(`Insufficient USDC balance. Have: ${ethers.formatUnits(balance, 6)}, Need: ${amount}`)
      }

      const currentAllowance = await usdcContract.allowance(userAddress, chainConfig.TOKEN_MESSENGER)
      if (currentAllowance < amountInUnits) {
        const approveTx = await usdcContract.approve(chainConfig.TOKEN_MESSENGER, amountInUnits)
        await approveTx.wait()
      }

      const tokenMessenger = new ethers.Contract(
        chainConfig.TOKEN_MESSENGER,
        [
          'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)',
          'function depositForBurnWithCaller(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller) returns (uint64 nonce)'
        ],
        signer
      )

      const suiAddressBytes32 = this.convertSuiAddressToBytes32(this.suiRecipient)

      const burnTx = await tokenMessenger.depositForBurn(
        amountInUnits,
        SUI_DOMAIN_ID,
        suiAddressBytes32,
        chainConfig.USDC_TOKEN
      )

      const receipt = await burnTx.wait()
      const attestationResult = await this.getCircleAttestation(receipt.hash)

      return {
        success: true,
        txHash: receipt.hash,
        attestationHash: attestationResult.attestationHash
      }

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  private async getCircleAttestation(txHash: string): Promise<{
    attestationHash?: string
    attestation?: string
  }> {
    try {
      let attempts = 0
      const maxAttempts = 20
      
      while (attempts < maxAttempts) {
        try {
          const response = await fetch(
            `${this.circleAttestationUrl}/attestations/${txHash}`,
            {
              method: 'GET',
              headers: {
                'Accept': 'application/json'
              }
            }
          )

          if (response.ok) {
            const result = await response.json()
            if (result.status === 'complete') {
              return {
                attestationHash: result.attestation,
                attestation: result.attestation
              }
            }
          }

          await new Promise(resolve => setTimeout(resolve, 6000))
          attempts++

        } catch (error) {
          attempts++
          await new Promise(resolve => setTimeout(resolve, 6000))
        }
      }

      throw new Error('Circle attestation timeout')

    } catch (error: any) {
      return {}
    }
  }

  async retrieveFromWalrus(blobId: string): Promise<{
    success: boolean
    data?: any
    contentType?: string
    error?: string
  }> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      try {
        const response = await fetch(
          `${this.walrusAggregator}/v1/blobs/${blobId}`,
          { signal: controller.signal }
        )

        clearTimeout(timeoutId)

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`Blob not found: ${blobId}`)
          }
          throw new Error(`Retrieval failed: ${response.status} ${response.statusText}`)
        }

        const contentType = response.headers.get('content-type') || 'application/octet-stream'
        const arrayBuffer = await response.arrayBuffer()
        
        let parsedData: any
        try {
          if (contentType.includes('text') || contentType.includes('json')) {
            const textData = new TextDecoder().decode(arrayBuffer)
            try {
              parsedData = JSON.parse(textData)
            } catch {
              parsedData = textData
            }
          } else {
            parsedData = new Uint8Array(arrayBuffer)
          }
        } catch {
          parsedData = new Uint8Array(arrayBuffer)
        }

        return {
          success: true,
          data: parsedData,
          contentType
        }

      } catch (error: any) {
        clearTimeout(timeoutId)
        if (error.name === 'AbortError') {
          throw new Error('Retrieval timeout')
        }
        throw error
      }

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  async checkWalrusHealth(): Promise<{
    publisherHealthy: boolean
    aggregatorHealthy: boolean
    publisherLatency?: number
    aggregatorLatency?: number
    error?: string
  }> {
    try {
      const checkEndpoint = async (url: string) => {
        const start = Date.now()
        try {
          const response = await fetch(`${url}/v1/api`, { 
            method: 'GET',
            signal: AbortSignal.timeout(10000)
          })
          const latency = Date.now() - start
          return { healthy: response.ok, latency }
        } catch {
          return { healthy: false, latency: Date.now() - start }
        }
      }

      const [publisherResult, aggregatorResult] = await Promise.all([
        checkEndpoint(this.walrusPublisher),
        checkEndpoint(this.walrusAggregator)
      ])

      return {
        publisherHealthy: publisherResult.healthy,
        aggregatorHealthy: aggregatorResult.healthy,
        publisherLatency: publisherResult.latency,
        aggregatorLatency: aggregatorResult.latency
      }
    } catch (error: any) {
      return {
        publisherHealthy: false,
        aggregatorHealthy: false,
        error: error.message
      }
    }
  }

  async getUSDCBalance(signer: ethers.Signer, sourceChain: string = 'arbitrum'): Promise<string> {
    try {
      const chainConfig = CCTP_CONTRACTS[this.network]?.[sourceChain]
      if (!chainConfig) {
        throw new Error(`Unsupported chain: ${sourceChain}`)
      }

      const usdcContract = new ethers.Contract(
        chainConfig.USDC_TOKEN,
        ['function balanceOf(address owner) view returns (uint256)'],
        signer
      )

      const balance = await usdcContract.balanceOf(await signer.getAddress())
      return ethers.formatUnits(balance, 6)
    } catch (error) {
      return '0'
    }
  }

  getNetworkConfig() {
    return {
      network: this.network,
      walrusPublisher: this.walrusPublisher,
      walrusAggregator: this.walrusAggregator,
      circleAttestationUrl: this.circleAttestationUrl,
      supportedChains: Object.keys(CCTP_CONTRACTS[this.network]),
      contracts: CCTP_CONTRACTS[this.network]
    }
  }

  private convertSuiAddressToBytes32(suiAddress: string): string {
    const cleanAddress = suiAddress.replace('0x', '').padStart(64, '0').toLowerCase()
    return '0x' + cleanAddress
  }
}

export class ProductionWalrusStorage {
  private bridge: EthWalrusBridge

  constructor(config?: BridgeConfig) {
    this.bridge = new EthWalrusBridge(config)
  }

  async storeData(data: any, epochs: number = 5): Promise<{
    success: boolean
    blobId?: string
    walrusUrl?: string
    error?: string
  }> {
    const health = await this.bridge.checkWalrusHealth()
    
    if (!health.publisherHealthy) {
      return {
        success: false,
        error: `Walrus publisher unavailable`
      }
    }

    const result = await this.bridge.storeOnWalrus(data, epochs)
    
    return {
      success: result.success,
      blobId: result.blobId,
      walrusUrl: result.walrusUrl,
      error: result.error
    }
  }

  async getData(blobId: string): Promise<{
    success: boolean
    data?: any
    contentType?: string
    error?: string
  }> {
    return await this.bridge.retrieveFromWalrus(blobId)
  }

  async storeWithBridge(
    signer: ethers.Signer, 
    data: any, 
    usdcAmount: string = "1.0",
    sourceChain: string = 'arbitrum'
  ): Promise<{
    success: boolean
    blobId?: string
    bridgeTx?: string
    attestationHash?: string
    error?: string
  }> {
    const balance = await this.bridge.getUSDCBalance(signer, sourceChain)
    if (parseFloat(balance) < parseFloat(usdcAmount)) {
      return {
        success: false,
        error: `Insufficient USDC balance on ${sourceChain}. Have: ${balance}, Need: ${usdcAmount}`
      }
    }

    const result = await this.bridge.bridgeAndStore(signer, data, usdcAmount, sourceChain)
    
    return {
      success: result.success,
      blobId: result.blobId,
      bridgeTx: result.bridgeTxHash,
      attestationHash: result.attestationHash,
      error: result.error
    }
  }

  async getNetworkStatus() {
    const config = this.bridge.getNetworkConfig()
    const health = await this.bridge.checkWalrusHealth()
    
    return {
      ...config,
      health: {
        publisher: {
          healthy: health.publisherHealthy,
          latency: health.publisherLatency
        },
        aggregator: {
          healthy: health.aggregatorHealthy,
          latency: health.aggregatorLatency
        }
      }
    }
  }
}

export function useWalrusProduction(config?: BridgeConfig) {
  const bridge = new EthWalrusBridge(config)

  const storeData = async (data: any, epochs: number = 5) => {
    return await bridge.storeOnWalrus(data, epochs)
  }

  const retrieveData = async (blobId: string) => {
    return await bridge.retrieveFromWalrus(blobId)
  }

  const checkHealth = async () => {
    return await bridge.checkWalrusHealth()
  }

  const getBalance = async (signer: ethers.Signer, chain: string = 'arbitrum') => {
    return await bridge.getUSDCBalance(signer, chain)
  }

  const storeWithBridge = async (
    signer: ethers.Signer, 
    data: any, 
    amount?: string,
    sourceChain?: string
  ) => {
    return await bridge.bridgeAndStore(signer, data, amount, sourceChain)
  }

  const getNetworkConfig = () => {
    return bridge.getNetworkConfig()
  }

  return {
    storeData,
    retrieveData,
    checkHealth,
    getBalance,
    storeWithBridge,
    getNetworkConfig
  }
}

export {
  CCTP_CONTRACTS,
  WALRUS_ENDPOINTS,
  CIRCLE_ATTESTATION_URLS
}
