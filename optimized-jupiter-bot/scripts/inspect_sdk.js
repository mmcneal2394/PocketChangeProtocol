const sdk = require('@jup-ag/referral-sdk');
console.log('SDK keys:', Object.keys(sdk));
if (sdk.ReferralProvider) {
  const rp = sdk.ReferralProvider;
  console.log('ReferralProvider methods:', Object.getOwnPropertyNames(rp.prototype));
}
