import Privacy from '../../src/components/privacy';

describe('Privacy class', function() {
  it('should have a render method', () => {
    // new instance of the Privacy component to be used in this test
    let privacy = new Privacy;
    // expect the render() method to be defined in the Privacy class
    expect(privacy.render).toBeDefined();
  });
});
