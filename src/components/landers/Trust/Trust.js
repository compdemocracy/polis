import React from "react";
import PropTypes from "prop-types";
import classnames from "classnames";
import Figure from '../../Core/Image/Figure'

const Trust = ({ headline, subheadline, className }) => {
  return <section className={classnames("mb2", "mb3-m", "mb4-l", "ph3", "pv4", "bg-light-blue", className)}>
      <header className="ph4 tc-ns center">
        <h2 className="f2 ttc bodoni lh-solid lh-title-m  mb3 ">
          {headline}
        </h2>
        <p className="f4 f3-l mb4 measure center lh-copy">{subheadline}</p>
      </header>

      <div className="flex flex-wrap justify-center">
        <Figure src="http://via.placeholder.com/125x125" className="mh1 mb2" />
        <Figure src="http://via.placeholder.com/125x125" className="mh1 mb2" />
        <Figure src="http://via.placeholder.com/125x125" className="mh1 mb2" />
        <Figure src="http://via.placeholder.com/125x125" className="mh1 mb2" />
      </div>
    </section>;
};

Trust.propTypes = {
  headline: PropTypes.string.isRequired,
  subheadline: PropTypes.string.isRequired,
  className: PropTypes.string
};

export default Trust;
