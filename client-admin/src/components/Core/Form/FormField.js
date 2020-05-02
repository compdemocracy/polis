import React from "react";
import PropTypes from "prop-types";

const FormField = ({ children, ...props }) => {
  return (
    <div className="form-field mb3 w-50" {...props}>
      {children}
    </div>
  );
};

FormField.propTypes = {
  children: PropTypes.any.isRequired,
  className: PropTypes.string
};

export default FormField;
