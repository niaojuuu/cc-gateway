import { randomBytes } from 'crypto'

const deviceId = randomBytes(32).toString('hex')

console.log(`\nGenerated canonical identity:\n`)
console.log(`identity:`)
console.log(`  device_id: "${deviceId}"`)
console.log(`\nPut this in your config.yaml. All clients will appear as this device.`)
