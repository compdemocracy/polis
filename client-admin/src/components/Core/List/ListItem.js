import React from "react";
import PropTypes from "prop-types";

const ListItem = ({ children, className, ...props }) => {
  return (
    <li className={className} {...props}>
      {children}
    </li>
  );
};

ListItem.propTypes = {
  children: PropTypes.any.isRequired,
  className: PropTypes.string
};

export default ListItem;
