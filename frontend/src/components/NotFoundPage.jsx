import {Link} from 'react-router-dom';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

export default function NotFoundPage() {
  return (
    <section className="not-found-container" role="main" aria-label="Page not found">
      <div className="not-found-card">
        <Link className="not-found-help-icon" to="/how-to-use" title="Help & guide" aria-label="Help & guide">
          <PhosphorIcon name="info" size={17} />
        </Link>
        <div className="">
          <span className="not-found-code">404 </span>
          <span className="not-found-tag">PAGE NOT FOUND</span>
        </div>
        <h1>Lost in the markets?</h1>
        <p className="not-found-desc">
          The page or contract market you are looking for does not exist, has been archived, or the link may be broken.
        </p>
        <div className="not-found-actions">
          <Link className="button button-quiet not-found-return-btn" to="/markets">
            <PhosphorIcon name="arrowLeft" size={14} />
            <span>Return to markets</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
