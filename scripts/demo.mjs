import {resolvePrice} from '../service/policy.mjs';
const observations=['320000000000','321000000000','319000000000'].map((price,i)=>({source:`fixture-${i}`,price,observedAt:200}));
console.log('Offline resolution policy demonstration (fixture data, no chain transaction):');
console.log(`Median USD price: ${resolvePrice(observations,200,205)} in 10^-8 USD units`);
console.log('For actual escrow/payout execution run: cd contracts && cargo test');
