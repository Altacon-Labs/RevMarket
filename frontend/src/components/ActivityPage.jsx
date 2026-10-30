import BackendPanel from '../BackendPanel.jsx';
import AutomationPanel from '../AutomationPanel.jsx';

export default function ActivityPage(props) {
  return <>
    <div className="page-heading"><div><p className="eyebrow">ACCOUNT ACTIVITY</p><h1>Activity and automation</h1></div></div>
    <div className="activity-layout">
      <BackendPanel {...props} />
      <AutomationPanel />
    </div>
  </>;
}