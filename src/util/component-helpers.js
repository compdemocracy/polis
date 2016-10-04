


const helpers = {};

helpers.shouldShowPermissionsError = (props) => {
  return props.zid_metadata && !props.zid_metadata.is_owner && !props.zid_metadata.is_mod;
};


export default helpers;
