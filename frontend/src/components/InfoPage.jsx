import {Link} from 'react-router-dom';

const pages = {
  'how-to-use': {
    eyebrow: 'GUIDE', title: 'How to use RevMarket', intro: 'Browse a market, read its terms, and connect Freighter only when you are ready to authorize a Stellar Testnet transaction.',
    sections: [['Browse markets', 'Use the market categories or search to find a question. Open a market to review its close time, pool sizes, and resolution notes.'], ['Sign in or connect a wallet', 'Privy sign-in creates a RevMarket account using email OTP or supported web3 wallets. Freighter is a separate connection used to sign Stellar transactions.'], ['Take a position', 'On a deployed market, choose YES or NO, enter a test XLM amount, and review the transaction in Freighter. Never approve a transaction you do not understand.'], ['Resolution and claims', 'Markets are resolved by the configured operator. If the resolution deadline expires, eligible positions may claim a refund according to the contract.']],
  },
  'how-it-works': {
    eyebrow: 'PROTOCOL', title: 'How RevMarket works', intro: 'RevMarket is a binary prediction-market prototype using a Soroban escrow contract and an operator-run resolution service.',
    sections: [['Create', 'A market records a yes/no question, type, close time, and resolution deadline on Stellar. Price markets use BTC, ETH, or XLM observations.'], ['Stake', 'Participants select YES or NO and escrow test XLM. One position per wallet is supported for each market.'], ['Resolve', 'After closing, an authorized resolver submits an outcome and evidence digest. The contract checks authorization and timing; price evidence checks run in the off-chain service.'], ['Settle or refund', 'Winners receive a proportional payout. A missed resolution deadline opens the refund path. The operator key remains a centralized trust assumption.']],
  },
  terms: {
    eyebrow: 'LEGAL', title: 'Terms of use', intro: 'RevMarket is a software prototype for Stellar Testnet. These notices describe the current demo and are not a substitute for jurisdiction-specific legal terms.',
    sections: [['Testnet use only', 'The app is provided for testing and evaluation. Test XLM has no intended cash value. Do not use the prototype to handle production funds.'], ['No financial advice', 'Markets, pool balances, charts, and outcomes are informational software data, not a recommendation to trade or a promise of return.'], ['Wallet transactions', 'You are responsible for reviewing each wallet prompt and for safeguarding your wallet. Transactions submitted to a public network may be irreversible.'], ['Availability and changes', 'The prototype may be unavailable, incomplete, or changed without notice. Do not rely on it for critical decisions.']],
  },
  privacy: {
    eyebrow: 'LEGAL', title: 'Privacy policy', intro: 'RevMarket is a testnet prototype. This page summarizes the data paths in the current app and should be replaced with reviewed production privacy terms before launch.',
    sections: [['Privy authentication', 'When enabled, Privy processes sign-in information such as an email address or linked wallet account. RevMarket does not receive your email password or wallet secret. See Privy’s own privacy materials for its processing and retention practices.'], ['Public blockchain data', 'Stellar addresses and transactions submitted to the network are public and cannot be removed by RevMarket.'], ['Optional activity service', 'The optional local backend supports signed wallet sessions and user-reported activity. Reported activity is not independently verified chain history.'], ['Contact and retention', 'This prototype does not define a production support contact or retention schedule. Do not submit sensitive personal information.']],
  },
  risk: {
    eyebrow: 'LEGAL', title: 'Risk disclosure', intro: 'Prediction markets involve uncertainty. This testnet prototype is unaudited and is not designed for real-money use.',
    sections: [['Smart-contract risk', 'Contract defects, network failures, wallet errors, or compromised keys may cause loss or lockup of test assets. The configured resolver key can authorize outcomes.'], ['Resolution risk', 'Event evidence providers may be unavailable or disagree. Price markets use first post-close observations, not a historical candle close.'], ['Market-data risk', 'Displayed sample values and illustrative charts are not live odds or price feeds. Pool share is not a guaranteed probability.'], ['Regulatory risk', 'Rules for prediction markets and digital assets vary by location. You are responsible for understanding applicable restrictions.']],
  },
  licenses: {
    eyebrow: 'PROJECT', title: 'Licenses and attributions', intro: 'RevMarket source code is provided under the repository MIT license. Third-party dependencies and icon assets retain their own licenses.',
    sections: [['RevMarket', 'The repository includes the MIT license at its root.'], ['Phosphor icons', 'The frontend icon assets are distributed under the Phosphor license; see the repository third-party notices.'], ['Dependencies', 'See the npm package metadata and each dependency’s license for applicable terms.']],
  },
};

export default function InfoPage({page}) {
  const content = pages[page];
  if (!content) return <section className="page-state"><p className="eyebrow">NOT FOUND</p><h1>Page not found</h1><Link className="button button-secondary" to="/markets">Back to markets</Link></section>;
  return <article className="info-page"><p className="eyebrow">{content.eyebrow}</p><h1>{content.title}</h1><p className="info-intro">{content.intro}</p><div className="info-sections">{content.sections.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}</div><Link className="back-link" to="/markets">← Back to markets</Link></article>;
}