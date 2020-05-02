import React from "react";
import PropTypes from "prop-types";
  
import Figure from "../Image/Figure"

const PropItem = ({ headline, teaser, src }) => {

  return (
    <article className="flex-column w-100 w-50-ns ph4 ph0-ns pr5-l mb5">
      <Figure
        src={src}
        className="w3 h3 w4-ns h4-ns"
      />
      <div className="pr2 pr5-m">
        <h4 className="ttc">{headline}</h4>
        <p className="lh-copy">{teaser}</p>
      </div>
    </article>
  );
};

PropItem.propTypes = {
  src: PropTypes.string.isRequired,
  headline: PropTypes.string.isRequired,
  headline: PropTypes.string.isRequired
};

export default PropItem;
