// Simple developer tool for bridging ETH users to Walrus storage on Sui

import { ethers } from 'ethers'

interface BridgeConfig {
  walrusEndpoint?: string
  suiRecipientAddress?: string
  arbitrumRpcUrl?: string
}

interface StorageResult {
  success: boolean
  blobId?: string
  suiObjectId?: string
  bridgeTxHash?: string
  error?: string
}

// Wormhole CCTP contracts for Arbitrum Sepolia
const WORMHOLE_CONTRACTS = {
  ARBITRUM_SEPOLIA: {
    CORE_BRIDGE: '0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35',
    TOKEN_BRIDGE: '0xC7A204bDBFe983FCD8d8E61D02b475D4073fF97e',
    USDC_TOKEN: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'
  }
}

const CHAIN_IDS = {
  ARBITRUM_SEPOLIA: 23,
  SUI_TESTNET: 21
}

// Default Sui address for receiving bridged USDC
const DEFAULT_SUI_ADDRESS = '0x7b005829a1305a3ebeea7cff0dd200bbe7e2f42d1adce0d9045dd57ef12f52c9'

export class EthWalrusBridge {
  private config: BridgeConfig
  private walrusEndpoint: string
  private suiRecipient: string

  constructor(config: BridgeConfig = {}) {
    this.config = config
    this.walrusEndpoint = config.walrusEndpoint || 'http://localhost:31417' // Local Walrus daemon
    this.suiRecipient = config.suiRecipientAddress || DEFAULT_SUI_ADDRESS
  }

  /**
   * Bridge USDC from Ethereum to Sui and store data on Walrus
   * @param signer - Ethereum signer (from MetaMask, etc.)
   * @param data - Data to store on Walrus (string or object)
   * @param amount - USDC amount to bridge (default: "1.0")
   * @returns Promise with storage result
   */
  async bridgeAndStore(
    signer: ethers.Signer, 
    data: any, 
    amount: string = "1.0"
  ): Promise<StorageResult> {
    try {
      console.log('🌉 Starting bridge and storage process...')

      // Step 1: Bridge USDC to Sui via Wormhole
      const bridgeResult = await this.bridgeUSDC(signer, amount)
      if (!bridgeResult.success) {
        return { success: false, error: bridgeResult.error }
      }

      // Step 2: Store data on Walrus
      const storageResult = await this.storeOnWalrus(data)
      if (!storageResult.success) {
        return { 
          success: false, 
          error: storageResult.error,
          bridgeTxHash: bridgeResult.txHash // Still return bridge tx
        }
      }

      return {
        success: true,
        blobId: storageResult.blobId,
        suiObjectId: storageResult.suiObjectId,
        bridgeTxHash: bridgeResult.txHash
      }

    } catch (error: any) {
      console.error('❌ Bridge and store failed:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  /**
   * Bridge USDC from Arbitrum to Sui via Wormhole CCTP
   */
  private async bridgeUSDC(signer: ethers.Signer, amount: string): Promise<{
    success: boolean
    txHash?: string
    wormholeSequence?: string
    error?: string
  }> {
    try {
      console.log(`💰 Bridging ${amount} USDC to Sui...`)

      const amountInUnits = ethers.parseUnits(amount, 6) // USDC has 6 decimals

      // Get Wormhole fee
      const coreBridge = new ethers.Contract(
        WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.CORE_BRIDGE,
        ['function messageFee() view returns (uint256)'],
        signer
      )
      const wormholeFee = await coreBridge.messageFee()

      // Approve USDC
      const usdcContract = new ethers.Contract(
        WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.USDC_TOKEN,
        [
          'function approve(address spender, uint256 amount) returns (bool)',
          'function allowance(address owner, address spender) view returns (uint256)'
        ],
        signer
      )

      const currentAllowance = await usdcContract.allowance(
        await signer.getAddress(),
        WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.TOKEN_BRIDGE
      )

      if (currentAllowance < amountInUnits) {
        const approveTx = await usdcContract.approve(
          WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.TOKEN_BRIDGE,
          amountInUnits
        )
        await approveTx.wait()
      }

      // Bridge via Wormhole
      const tokenBridgeContract = new ethers.Contract(
        WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.TOKEN_BRIDGE,
        [
          'function transferTokens(address token, uint256 amount, uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce) payable returns (uint64 sequence)'
        ],
        signer
      )

      const suiAddressBytes32 = this.convertSuiAddressToBytes32(this.suiRecipient)
      const nonce = crypto.getRandomValues(new Uint32Array(1))[0]

      const bridgeTx = await tokenBridgeContract.transferTokens(
        WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.USDC_TOKEN,
        amountInUnits,
        CHAIN_IDS.SUI_TESTNET,
        suiAddressBytes32,
        BigInt(0), // No arbiter fee
        nonce,
        { value: wormholeFee }
      )

      const receipt = await bridgeTx.wait()
      const sequence = this.extractWormholeSequence(receipt)

      console.log('✅ Bridge completed:', receipt.hash)

      return {
        success: true,
        txHash: receipt.hash,
        wormholeSequence: sequence
      }

    } catch (error: any) {
      console.error('❌ Bridge failed:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  /**
   * Store data on Walrus storage
   */
  private async storeOnWalrus(data: any): Promise<{
    success: boolean
    blobId?: string
    suiObjectId?: string
    error?: string
  }> {
    try {
      console.log('💾 Storing data on Walrus...')

      const blob = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2))

      const response = await fetch(`${this.walrusEndpoint}/v1/blobs?epochs=5`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: blob,
      })

      if (!response.ok) {
        throw new Error(`Walrus storage failed: ${response.status}`)
      }

      const result = await response.json()

      if (result.newlyCreated) {
        console.log('✅ Data stored on Walrus:', result.newlyCreated.blobObject.blobId)
        return {
          success: true,
          blobId: result.newlyCreated.blobObject.blobId,
          suiObjectId: result.newlyCreated.blobObject.id
        }
      } else if (result.alreadyCertified) {
        console.log('✅ Data already exists on Walrus:', result.alreadyCertified.blobId)
        return {
          success: true,
          blobId: result.alreadyCertified.blobId,
          suiObjectId: result.alreadyCertified.event.txDigest
        }
      }

      throw new Error('Unexpected Walrus response')

    } catch (error: any) {
      console.error('❌ Walrus storage failed:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  /**
   * Retrieve data from Walrus storage
   */
  async retrieveFromWalrus(blobId: string): Promise<{
    success: boolean
    data?: any
    error?: string
  }> {
    try {
      console.log(`📥 Retrieving blob: ${blobId}`)

      const response = await fetch(`${this.walrusEndpoint}/v1/blobs/${blobId}`)

      if (!response.ok) {
        throw new Error(`Retrieval failed: ${response.status}`)
      }

      const data = await response.text()
      
      // Try to parse as JSON, fallback to raw text
      let parsedData
      try {
        parsedData = JSON.parse(data)
      } catch {
        parsedData = data
      }

      console.log(`✅ Data retrieved: ${blobId}`)
      return {
        success: true,
        data: parsedData
      }

    } catch (error: any) {
      console.error('❌ Retrieval failed:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  /**
   * Check if Walrus daemon is running
   */
  async checkWalrusHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.walrusEndpoint}/v1/api`, { 
        timeout: 5000 
      })
      return response.ok
    } catch (error) {
      console.warn('⚠️ Walrus daemon not accessible:', error)
      return false
    }
  }

  /**
   * Get user's USDC balance on Arbitrum
   */
  async getUSDCBalance(signer: ethers.Signer): Promise<string> {
    try {
      const usdcContract = new ethers.Contract(
        WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.USDC_TOKEN,
        ['function balanceOf(address owner) view returns (uint256)'],
        signer
      )

      const balance = await usdcContract.balanceOf(await signer.getAddress())
      return ethers.formatUnits(balance, 6) // USDC has 6 decimals
    } catch (error) {
      console.error('Failed to get USDC balance:', error)
      return '0'
    }
  }

  // Helper methods
  private convertSuiAddressToBytes32(suiAddress: string): string {
    const cleanAddress = suiAddress.replace('0x', '').padStart(64, '0').toLowerCase()
    return '0x' + cleanAddress
  }

  private extractWormholeSequence(receipt: ethers.TransactionReceipt): string {
    const wormholeInterface = new ethers.Interface([
      'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)'
    ])

    for (const log of receipt.logs) {
      try {
        if (log.address.toLowerCase() === WORMHOLE_CONTRACTS.ARBITRUM_SEPOLIA.CORE_BRIDGE.toLowerCase()) {
          const parsed = wormholeInterface.parseLog({
            topics: log.topics,
            data: log.data
          })
          if (parsed?.name === 'LogMessagePublished') {
            return parsed.args.sequence.toString()
          }
        }
      } catch (e) {
        // Continue to next log
      }
    }
    return 'unknown'
  }
}

// Example usage for developers
export class SimpleEthWalrusExample {
  private bridge: EthWalrusBridge

  constructor() {
    this.bridge = new EthWalrusBridge({
      walrusEndpoint: 'http://localhost:31417', // Local Walrus daemon
      suiRecipientAddress: '0x7b005829a1305a3ebeea7cff0dd200bbe7e2f42d1adce0d9045dd57ef12f52c9'
    })
  }

  /**
   * Simple method for developers to store user data
   */
  async storeUserData(signer: ethers.Signer, userData: any): Promise<{
    success: boolean
    blobId?: string
    bridgeTx?: string
    error?: string
  }> {
    // Check if user has enough USDC
    const balance = await this.bridge.getUSDCBalance(signer)
    if (parseFloat(balance) < 1) {
      return {
        success: false,
        error: 'Insufficient USDC balance. Need at least 1 USDC.'
      }
    }

    // Check if Walrus is accessible
    const walrusHealthy = await this.bridge.checkWalrusHealth()
    if (!walrusHealthy) {
      return {
        success: false,
        error: 'Walrus daemon not accessible. Please start Walrus daemon.'
      }
    }

    // Store the data
    const result = await this.bridge.bridgeAndStore(signer, userData, "1.0")
    
    return {
      success: result.success,
      blobId: result.blobId,
      bridgeTx: result.bridgeTxHash,
      error: result.error
    }
  }

  /**
   * Simple method to retrieve stored data
   */
  async getUserData(blobId: string): Promise<{
    success: boolean
    data?: any
    error?: string
  }> {
    return await this.bridge.retrieveFromWalrus(blobId)
  }
}

// React Hook for easy integration (optional)
export function useEthWalrus() {
  const bridge = new EthWalrusBridge()

  const storeData = async (signer: ethers.Signer, data: any) => {
    return await bridge.bridgeAndStore(signer, data)
  }

  const retrieveData = async (blobId: string) => {
    return await bridge.retrieveFromWalrus(blobId)
  }

  const checkHealth = async () => {
    return await bridge.checkWalrusHealth()
  }

  const getBalance = async (signer: ethers.Signer) => {
    return await bridge.getUSDCBalance(signer)
  }

  return {
    storeData,
    retrieveData,
    checkHealth,
    getBalance
  }
}
