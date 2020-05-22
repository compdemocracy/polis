import React from "react";

const FormField = ({ children, ...props }) => {
  return (
    <div className="form-field mb3 w-50" {...props}>
      {children}
    </div>
  );
};

export default FormField;
