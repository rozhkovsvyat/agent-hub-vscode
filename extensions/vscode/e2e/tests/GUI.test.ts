import { expect } from "chai";
import {
  By,
  EditorView,
  Key,
  VSBrowser,
  WebDriver,
  WebView,
  until,
} from "vscode-extension-tester";

import { GlobalActions } from "../actions/Global.actions";
import { GUIActions } from "../actions/GUI.actions";
import { DEFAULT_TIMEOUT } from "../constants";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";

describe.skip("GUI Test", () => {
  let view: WebView;
  let driver: WebDriver;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT.XL + DEFAULT_TIMEOUT.MD + DEFAULT_TIMEOUT.MD);
    // Uncomment this line for faster testing
    await GUIActions.moveContinueToSidebar(VSBrowser.instance.driver);
    await GlobalActions.openTestWorkspace();
    await GlobalActions.clearAllNotifications();
    await GlobalActions.disableNextEdit();
  });

  beforeEach(async function () {
    this.timeout(DEFAULT_TIMEOUT.XL);

    await GUIActions.toggleGui();

    ({ view, driver } = await GUIActions.switchToReactIframe());
    await GUIActions.selectModelFromDropdown(view, "TEST LLM");
  });

  afterEach(async function () {
    this.timeout(DEFAULT_TIMEOUT.XL);

    await view.switchBack();
    await TestUtils.waitForSuccess(
      async () => (await GUISelectors.getContinueExtensionBadge(view)).click(),
      DEFAULT_TIMEOUT.XS,
    );
    await new EditorView().closeAllEditors();
  });

  describe("Onboarding", () => {
    it.skip("should display correct panel description", async () => {
      const description = await GUISelectors.getDescription(view);

      expect(await description.getText()).has.string(
        "Log in to quickly build your first custom AI code agent",
      );
    }).timeout(DEFAULT_TIMEOUT.XL);

    // We no longer have a quick start button
    it.skip(
      "should display tutorial card after accepting onboarding quick start",
      async () => {
        // Get paragraph with text Best
        const bestTab = await GUISelectors.getOnboardingTabButton(view, "Best");
        await bestTab.click();

        const anthropicInput = await TestUtils.waitForSuccess(
          async () => await GUISelectors.getBestChatApiKeyInput(view),
        );
        anthropicInput.sendKeys("invalid_api_key");

        const mistralInput =
          await GUISelectors.getBestAutocompleteApiKeyInput(view);
        mistralInput.sendKeys("invalid_api_key");

        // Get button with text "Connect" and click it
        const connectButton = await view.findWebElement(
          By.xpath("//button[text()='Connect']"),
        );
        await connectButton.click();

        await TestUtils.waitForSuccess(
          async () => await GUISelectors.getTutorialCard(view),
        );

        // TODO validate that claude has been added to list

        // Skip testing Quick Start because github auth opens external app and breaks test
        // const quickStartButton = await view.findWebElement(
        //   By.xpath("//*[contains(text(), 'Get started using our API keys')]")
        // );
        // await quickStartButton.click();
        // await view.switchBack();
        // const allowButton = await TestUtils.waitForSuccess(
        //   async () => await driver.findElement(By.xpath(`//a[contains(text(), "Allow")]`))
        // );
        // await allowButton.click();
        // ({ view, driver } = await GUIActions.switchToReactIframe());
      },
    ).timeout(DEFAULT_TIMEOUT.XL);
  });

  describe("Chat", () => {
    it("Can submit message by pressing enter", async () => {
      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      const messagePair = TestUtils.generateTestMessagePair();
      await messageInput.sendKeys(messagePair.userMessage);
      await messageInput.sendKeys(Key.ENTER);
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, messagePair.llmResponse),
      );
    });

    it("Can submit message by button click", async () => {
      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      const messagePair = TestUtils.generateTestMessagePair();
      await messageInput.sendKeys(messagePair.userMessage);
      (await GUISelectors.getSubmitInputButton(view)).click();
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, messagePair.llmResponse),
      );
    });

    it("Can delete messages", async () => {
      const { userMessage: userMessage0, llmResponse: llmResponse0 } =
        TestUtils.generateTestMessagePair(0);
      await GUIActions.sendMessage({
        view,
        message: userMessage0,
        inputFieldIndex: 0,
      });
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse0),
      );

      const { userMessage: userMessage1, llmResponse: llmResponse1 } =
        TestUtils.generateTestMessagePair(1);
      await GUIActions.sendMessage({
        view,
        message: userMessage1,
        inputFieldIndex: 1,
      });
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse1),
      );

      const { userMessage: userMessage2, llmResponse: llmResponse2 } =
        TestUtils.generateTestMessagePair(2);
      await GUIActions.sendMessage({
        view,
        message: userMessage2,
        inputFieldIndex: 2,
      });
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse2),
      );

      // Delete the first assistant response (index 1) - this deletes both user msg 0 and assistant response 0
      await (await GUISelectors.getNthMessageDeleteButton(view, 1)).click();
      await TestUtils.expectNoElement(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse0),
      );

      // Delete the second assistant response (now at index 1) - this deletes both user msg 1 and assistant response 1
      await (await GUISelectors.getNthMessageDeleteButton(view, 1)).click();
      await TestUtils.expectNoElement(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse1),
      );

      // Delete the third assistant response (now at index 1) - this deletes both user msg 2 and assistant response 2
      await (await GUISelectors.getNthMessageDeleteButton(view, 1)).click();
      await TestUtils.expectNoElement(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse2),
      );
    }).timeout(DEFAULT_TIMEOUT.XL);

    it("Can edit messages", async () => {
      const { userMessage: userMessage0, llmResponse: llmResponse0 } =
        TestUtils.generateTestMessagePair(0);
      await GUIActions.sendMessage({
        view,
        message: userMessage0,
        inputFieldIndex: 0,
      });
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse0),
      );

      const { userMessage: userMessage1, llmResponse: llmResponse1 } =
        TestUtils.generateTestMessagePair(1);
      await GUIActions.sendMessage({
        view,
        message: userMessage1,
        inputFieldIndex: 1,
      });
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse1),
      );

      const { userMessage: userMessage2, llmResponse: llmResponse2 } =
        TestUtils.generateTestMessagePair(2);
      await GUIActions.sendMessage({
        view,
        message: userMessage2,
        inputFieldIndex: 2,
      });
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse2),
      );

      const secondInputField = await GUISelectors.getMessageInputFieldAtIndex(
        view,
        1,
      );
      await secondInputField.clear();

      const { userMessage: userMessage3, llmResponse: llmResponse3 } =
        TestUtils.generateTestMessagePair(3);

      await GUIActions.sendMessage({
        view,
        message: userMessage3,
        inputFieldIndex: 1,
      });
      await GUISelectors.getThreadMessageByText(view, llmResponse0);

      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, llmResponse3),
      );
      await Promise.all([
        TestUtils.expectNoElement(() =>
          GUISelectors.getThreadMessageByText(view, llmResponse1),
        ),
        TestUtils.expectNoElement(() =>
          GUISelectors.getThreadMessageByText(view, llmResponse2),
        ),
      ]);
    }).timeout(DEFAULT_TIMEOUT.XL);
  });

  describe("Agent with tools", () => {
    beforeEach(async () => {
      await GUIActions.selectModelFromDropdown(view, "TOOL MOCK LLM");
      await GUIActions.selectModeFromDropdown(view, "Agent");
    });

    it("should display rules peek and show rule details", async () => {
      // Send a message to trigger the model response
      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      await messageInput.sendKeys("Hello");
      await messageInput.sendKeys(Key.ENTER);

      // Wait for the response to appear
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, "I'm going to call a tool:"),
      );

      // Verify that "1 rule" text appears
      const rulesPeek = await TestUtils.waitForSuccess(() =>
        GUISelectors.getRulesPeek(view),
      );
      const rulesPeekText = await rulesPeek.getText();
      expect(rulesPeekText).to.include("1 rule");

      // Click on the rules peek to expand it
      await rulesPeek.click();

      // Wait for the rule details to appear
      const ruleItem = await TestUtils.waitForSuccess(() =>
        GUISelectors.getFirstRulesPeekItem(view),
      );

      await TestUtils.waitForSuccess(async () => {
        const text = await ruleItem.getText();
        if (!text || text.trim() === "") {
          throw new Error("Rule item text is empty");
        }
        return ruleItem;
      });

      // Verify the rule content
      const ruleItemText = await ruleItem.getText();
      expect(ruleItemText).to.include("Agent rule");
      expect(ruleItemText).to.include("Always applied");
      expect(ruleItemText).to.include("TEST_SYS_MSG");
    }).timeout(DEFAULT_TIMEOUT.MD);

    it("should render tool call", async () => {
      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      await messageInput.sendKeys("Hello");
      await messageInput.sendKeys(Key.ENTER);

      const statusMessage = await TestUtils.waitForSuccess(
        () => GUISelectors.getToolCallStatusMessage(view), // Defined in extensions/vscode/e2e/test-continue/config.json's TOOL MOCK LLM that we are calling the exact search tool
        DEFAULT_TIMEOUT.SM,
      );

      expect(await statusMessage.getText()).contain(
        "Continue viewed the git diff",
      );
    }).timeout(DEFAULT_TIMEOUT.MD * 100);

    it("should call tool after approval", async () => {
      await GUIActions.toggleToolPolicy(view, "view_diff", 2);

      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      await messageInput.sendKeys("Hello");
      await messageInput.sendKeys(Key.ENTER);

      const acceptToolCallButton = await TestUtils.waitForSuccess(() =>
        GUISelectors.getAcceptToolCallButton(view),
      );
      await acceptToolCallButton.click();

      const statusMessage = await TestUtils.waitForSuccess(
        () => GUISelectors.getToolCallStatusMessage(view), // Defined in extensions/vscode/e2e/test-continue/config.json's TOOL MOCK LLM that we are calling the exact search tool
        DEFAULT_TIMEOUT.SM,
      );

      const text = await statusMessage.getText();
      expect(text).contain("the git diff");
    }).timeout(DEFAULT_TIMEOUT.XL);

    it("should cancel tool", async () => {
      await GUIActions.toggleToolPolicy(view, "view_diff", 2);

      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      await messageInput.sendKeys("Hello");
      await messageInput.sendKeys(Key.ENTER);

      const cancelToolCallButton = await TestUtils.waitForSuccess(() =>
        GUISelectors.getRejectToolCallButton(view),
      );
      await cancelToolCallButton.click();

      const statusMessage = await TestUtils.waitForSuccess(
        () => GUISelectors.getToolCallStatusMessage(view), // Defined in extensions/vscode/e2e/test-continue/config.json's TOOL MOCK LLM that we are calling the exact search tool
        DEFAULT_TIMEOUT.SM,
      );

      const text = await statusMessage.getText();
      expect(text).contain("Continue tried to view the git diff");
    }).timeout(DEFAULT_TIMEOUT.XL);
  });

  describe("Context providers", () => {
    it("should successfully use the terminal context provider", async () => {
      await GUIActions.selectModelFromDropdown(view, "LAST MESSAGE MOCK LLM");

      // Enter just the context provider in the input and send
      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      await messageInput.sendKeys("@");
      await messageInput.sendKeys("terminal");
      await messageInput.sendKeys(Key.ENTER);
      await messageInput.sendKeys(Key.ENTER);

      // Check that the contents match what we expect (repeated back by the mock LLM)
      await TestUtils.waitForSuccess(() => {
        return GUISelectors.getThreadMessageByText(
          view,
          "Current terminal contents:",
        );
      });
    }).timeout(DEFAULT_TIMEOUT.MD);
  });

  describe("should repeat back the system message", () => {
    it("should repeat back the system message", async () => {
      await GUIActions.selectModeFromDropdown(view, "Chat");
      await GUIActions.selectModelFromDropdown(view, "SYSTEM MESSAGE MOCK LLM");
      const [messageInput] = await GUISelectors.getMessageInputFields(view);
      await messageInput.sendKeys("Hello");
      await messageInput.sendKeys(Key.ENTER);
      await TestUtils.waitForSuccess(() =>
        GUISelectors.getThreadMessageByText(view, "TEST_SYS_MSG"),
      );
    }).timeout(DEFAULT_TIMEOUT.XL * 1000);
  });

  describe("Chat Paths", () => {
    it("Open chat and send message → press arrow up and arrow down to cycle through messages → submit another message → press arrow up and arrow down to cycle through messages", async () => {
      await GUIActions.sendMessage({
        view,
        message: "MESSAGE 1",
        inputFieldIndex: 0,
      });

      const input1 = await TestUtils.waitForSuccess(async () => {
        return GUISelectors.getMessageInputFieldAtIndex(view, 1);
      });
      expect(await input1.getText()).to.equal("");

      await input1.sendKeys(Key.ARROW_UP);
      await driver.wait(
        until.elementTextIs(input1, "MESSAGE 1"),
        DEFAULT_TIMEOUT.SM,
      );

      await input1.sendKeys(Key.ARROW_DOWN); // First press - bring caret to the end of the message
      await input1.sendKeys(Key.ARROW_DOWN); // Second press - trigger message change
      await driver.wait(until.elementTextIs(input1, ""), DEFAULT_TIMEOUT.SM);

      await GUIActions.sendMessage({
        view,
        message: "MESSAGE 2",
        inputFieldIndex: 1,
      });

      const input2 = await TestUtils.waitForSuccess(async () => {
        return GUISelectors.getMessageInputFieldAtIndex(view, 2);
      });
      expect(await input2.getText()).to.equal("");

      await input2.sendKeys(Key.ARROW_UP);
      await driver.wait(
        until.elementTextIs(input2, "MESSAGE 2"),
        DEFAULT_TIMEOUT.SM,
      );

      await input2.sendKeys(Key.ARROW_UP);
      await driver.wait(
        until.elementTextIs(input2, "MESSAGE 1"),
        DEFAULT_TIMEOUT.SM,
      );

      await input2.sendKeys(Key.ARROW_DOWN); // First press - bring caret to the end of the message
      await input2.sendKeys(Key.ARROW_DOWN); // Second press - trigger message change
      await driver.wait(
        until.elementTextIs(input2, "MESSAGE 2"),
        DEFAULT_TIMEOUT.SM,
      );

      await input2.sendKeys(Key.ARROW_DOWN);
      await driver.wait(until.elementTextIs(input2, ""), DEFAULT_TIMEOUT.SM);
    }).timeout(DEFAULT_TIMEOUT.XL);
  });
});
