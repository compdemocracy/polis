import React from "react";

const ListItem = ({ children, className, ...props }) => {
  return (
    <li className={className} {...props}>
      {children}
    </li>
  );
};

export default ListItem;
