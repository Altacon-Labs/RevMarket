import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {PrivyProvider, usePrivy} from '@privy-io/react-auth';
import App from './App.jsx';
import './index.css';

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID;
const privyConfig = {
	loginMethods: ['email', 'wallet'],
	appearance: {
		theme: 'dark',
		accentColor: '#3698f4',
		landingHeader: 'Sign in to RevMarket',
		loginMessage: 'Use your email or a supported web3 wallet.',
	},
	embeddedWallets: {ethereum: {createOnLogin: 'off'}, solana: {createOnLogin: 'off'}},
};

function AuthenticatedApp() {
	const {ready, authenticated, user, login, logout} = usePrivy();
	return <App privyEnabled ready={ready} authenticated={authenticated} user={user} onLogin={login} onLogout={logout} />;
}

function Root() {
	const app = privyAppId
		? <PrivyProvider appId={privyAppId} config={privyConfig}><BrowserRouter><AuthenticatedApp /></BrowserRouter></PrivyProvider>
		: <BrowserRouter><App privyEnabled={false} /></BrowserRouter>;
	return <StrictMode>{app}</StrictMode>;
}

createRoot(document.getElementById('root')).render(<Root />);
