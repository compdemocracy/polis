import Privacy from '../../src/components/privacy';

describe('Privacy class', function() {
  it('should have a render method', () => {
    // new instance of the Privacy component to be used in this test
    let privacy = new Privacy;
    // expect the render() method to be defined in the Privacy class
    expect(privacy.render).toBeDefined();
  });

  it('should call the correct text', () => {
    let privacy = new Privacy;

    // stub the personalInformation() method from privacy instance to be a jest mock
    privacy.personalInformation = jest.fn();
    privacy.passiveInformationCollection = jest.fn();
    privacy.collectionOfInformation = jest.fn();

    // call the render method
    privacy.render();

    // expect render (from previous line) to call the correct text functions
    expect(privacy.personalInformation).toHaveBeenCalled();
    expect(privacy.passiveInformationCollection).toHaveBeenCalled();
    expect(privacy.collectionOfInformation).toHaveBeenCalled();
  });
});
