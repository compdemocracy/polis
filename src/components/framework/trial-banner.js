import React from 'react';

const styles = {
  root: {
    fontFamily: '"HelveticaNeue-Light", "Helvetica Neue Light", "Helvetica Neue", Helvetica, Arial, "Lucida Grande", sans-serif',
    fontWeight: 300,
  },
  header: {
    backgroundColor: 'rgba(3, 169, 244,.5)',
    color: 'white',
    padding: '16px',
    fontSize: '1em',
  },
};

const TrialBanner = (props) => {
  const rootStyle = props.style ? {...styles.root, ...props.style} : styles.root;

  return (
    <div style={rootStyle}>
      <div style={styles.header}>
        { props.title }
      </div>
      {props.children}
    </div>
  );
};

export default TrialBanner;
