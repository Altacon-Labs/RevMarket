import {useEffect,useRef,useState} from 'react';
import {api,logoutActivity,signInActivity} from './lib/backend.mjs';
import PhosphorIcon from './icons/PhosphorIcon.jsx';
import {ActivityEmptyState,ActivitySection} from './components/ActivitySection.jsx';

export default function BackendPanel({address,lastAction,authenticated,authEnabled,onLogin,onConnect}){
  const [state,setState]=useState({status:'checking',profile:null,items:[],message:''});
  const [busy,setBusy]=useState(false);
  const generation=useRef(0);
  const activeAddress=useRef(address);activeAddress.current=address;
  async function load(){
    const version=++generation.current;
    try{
      await api('/health');
      let profile=null,items=[];
      if(address){
        try{const me=await api('/me');if(me.wallet===address){profile=me;items=(await api('/activity')).items;}}
        catch(e){if(e.status!==401)throw e;}
      }
      if(version===generation.current)setState({status:'online',profile,items,message:''});
    }catch{if(version===generation.current)setState({status:'offline',profile:null,items:[],message:'The local backend could not be reached. Start it to use off-chain activity tracking.'});}
  }
  useEffect(()=>{setState(s=>({...s,profile:null,items:[]}));load();return()=>{generation.current++;};},[address,lastAction]);
  async function act(action){
    if(busy)return;
    const expected=address;
    setBusy(true);
    try{await action();if(activeAddress.current===expected)await load();}
    catch(e){if(activeAddress.current===expected)setState(s=>({...s,message:e.message}));}
    finally{setBusy(false);}
  }
  const statusLabel=state.status==='checking'?'Checking backend…':state.status==='online'?'Backend online':'Backend offline';
  let emptyState;
  if(state.status==='checking')emptyState={icon:'refresh',title:'Checking activity service',description:'Loading your off-chain activity status.'};
  else if(state.status==='offline')emptyState={icon:'info',title:'Activity service unavailable',description:state.message,action:{label:'Retry',disabled:busy,onClick:()=>act(load)}};
  else if(!authenticated)emptyState={icon:'user',title:'Sign in to view activity',description:'Sign in to your RevMarket account before connecting a Stellar wallet.',action:{label:'Sign in',disabled:!authEnabled,onClick:onLogin}};
  else if(!address)emptyState={icon:'wallet',title:'Connect a Stellar wallet',description:'Connect Freighter to create a wallet-scoped activity profile.',action:{label:'Connect Freighter',disabled:busy,onClick:onConnect}};
  else if(!state.profile)emptyState={icon:'user',title:'Activity profile not set up',description:'Create an optional off-chain profile to review actions reported by this app.',action:{label:'Enable activity profile',disabled:busy,onClick:()=>act(()=>signInActivity(address,()=>activeAddress.current===address))}};
  else if(state.items.length===0)emptyState={icon:'pulse',title:'No reported actions yet',description:'Market actions reported by this app will appear here.',action:{label:'Refresh',disabled:busy,onClick:()=>act(load)}};

  return <ActivitySection id="activity-profile-title" title="Activity profile" icon="wallet" status={statusLabel}>
    <p className="activity-section-copy">A message signature proves control of your public signing key for this off-chain session. It does not authorize transactions, spending or automation. No email, password or private key is requested.</p>
    {state.message && state.status==='online' && <p className="form-error" role="alert">{state.message}</p>}
    {state.profile && <div className="activity-actions">
      <button className="icon-button" type="button" title="Refresh activity" aria-label="Refresh activity" disabled={busy} onClick={()=>act(load)}><PhosphorIcon name="refresh" /></button>
      <button className="button button-quiet button-small" type="button" disabled={busy} onClick={()=>act(logoutActivity)}>Sign out of activity</button>
    </div>}
    {emptyState && <ActivityEmptyState {...emptyState} />}
    {state.profile && state.items.length>0 && <>
      <p className="activity-disclaimer">Reported by this app and not independently verified against the chain. Positions and payouts are read from the contract.</p>
      <ol className="activity-records">{state.items.slice(0,5).map(item=><li key={item.id}><span>{item.action}</span><code>{item.txHash.slice(0,12)}…</code></li>)}</ol>
      <button className="button button-quiet button-small" type="button" disabled={busy} onClick={()=>{if(window.confirm('Delete this off-chain profile and its reported activity? On-chain data will remain.'))act(()=>api('/me',{method:'DELETE'}));}}>Delete off-chain profile</button>
    </>}
  </ActivitySection>;
}
