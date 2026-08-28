const path = require("node:path");
const { tests } = require("@iobroker/testing");

// Runs the adapter in a real (temporary) js-controller instance and checks that it
// starts up without crashing. Without configured Loxone/Hue adapter instances and
// bridge credentials there isn't much more to exercise here - initHueBridge() will
// throw and log an error, which is expected and does not fail the test.
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("Object tree", getHarness => {
            it("should start the adapter without crashing", () => {
                const harness = getHarness();
                return harness.startAdapterAndWait();
            }).timeout(60000);
        });
    },
});
