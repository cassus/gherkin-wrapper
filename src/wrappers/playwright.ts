import { Library, LibraryMethodByStepType, WrapperArgs } from '../common/library';
import { TestFunction } from '../common/library';
import { Background, Feature, Rule, Scenario, Step, StepKeywordType } from '@cucumber/messages';
import { Wrapper as Base } from '../common/wrapper';
import { test as baseTestRunner } from '@playwright/test';

type BaseTestRunner = typeof baseTestRunner;
type TestArgs<T extends BaseTestRunner> = Parameters<Parameters<T>[1]>[0];
type ScenarioWrapper<T extends BaseTestRunner> = (
  stepsRunner: (args: TestArgs<T>) => Promise<any>,
) => (args: TestArgs<T>) => Promise<any>;

class Wrapper<T extends BaseTestRunner> extends Base<TestArgs<T>> {
  private testRunner: T;

  constructor(testRunner: T, library?: Library<TestArgs<T>>) {
    super(library);
    this.testRunner = testRunner;
  }

  protected runFeature(feature: Feature) {
    this.testRunner.describe(feature.name, () => {
      for (const child of feature.children)
        if (child.rule) this.runRule(child.rule);
        else if (child.background) this.runBackground(child.background);
        else if (child.scenario) this.runScenario(child.scenario);
    });
  }

  protected runRule(rule: Rule) {
    this.testRunner.describe(rule.name, () => {
      for (const child of rule.children)
        if (child.scenario) this.runScenario(child.scenario);
        else if (child.background) this.runBackground(child.background);
    });
  }

  protected runBackground(background: Background) {
    const steps = this.prepareSteps(background);
    const provideFixture = this.buildFixtureProvider(steps);

    this.testRunner.beforeEach(
      provideFixture(async (args: TestArgs<T>) => {
        for (const s of steps) this.runStep({ ...s, args });
      }),
    );
  }

  protected runScenarioOutline(scenarioOutline: Scenario) {
    const scenarios: Scenario[] = [];

    for (const ex of scenarioOutline.examples)
      if (ex.tableHeader)
        ex.tableBody.map((row, i) => {
          const scenario = Object.assign({}, scenarioOutline);
          if (ex.name !== '') scenario.name += ' -- ' + ex.name;
          scenario.name += ' (' + (i + 1) + ')';
          scenario.examples = [];
          scenario.steps = scenario.steps.map((step) => {
            ex.tableHeader?.cells.map((cell, j) => {
              step.text = step.text.replace('<' + cell.value + '>', row.cells[j].value);
            });
            return step;
          });
          scenarios.push(scenario);
        });

    for (const s of scenarios) this.runScenario(s);
  }

  protected runScenario(scenario: Scenario) {
    if (scenario.examples.length) return this.runScenarioOutline(scenario);

    const steps = this.prepareSteps(scenario);
    const provideFixture = this.buildFixtureProvider(steps);

    this.testRunner(
      scenario.name,
      provideFixture(async (args: TestArgs<T>) => {
        for (const s of steps) await this.runStep({ ...s, args });
      }),
    );
  }

  protected async runStep({
    step,
    test,
    args,
    wrapperArgs,
  }: {
    step: Step;
    test?: TestFunction<TestArgs<T>>;
    args: TestArgs<T>;
    wrapperArgs: WrapperArgs;
  }) {
    await this.testRunner.step(step.keyword + step.text, async () => {
      this.testRunner.skip(
        !test,
        `No test function found for step '${step.keyword + step.text}'. You shoul add one using the GherkinWrapper.${
          LibraryMethodByStepType[step.keywordType as StepKeywordType]
        } method`,
      );
      await test?.(args, { ...wrapperArgs, dataTable: step.dataTable, docString: step.docString?.content });
    });
  }

  private prepareSteps(backgroundOrScenario: Background | Scenario) {
    return backgroundOrScenario.steps.reduce((list, step, index) => {
      return list.concat([{ step, ...this.getTestFunction(step, list[index - 1]?.keywordType) }]);
    }, [] as (ReturnType<typeof this.getTestFunction> & { step: Step })[]);
  }

  private buildFixtureProvider(steps: { test?: TestFunction<TestArgs<T>> }[]): ScenarioWrapper<T> {
    const requiredFixtureNames =
      '{' +
      [
        ...new Set(
          steps
            .map(({ test }) => fixtureParameterNames(test))
            .reduce((list, fixtureNames) => list.concat(fixtureNames), []),
        ),
      ].join(',') +
      '}';
    return new Function(
      'runSteps',
      `return ((${requiredFixtureNames}) => runSteps(${requiredFixtureNames}))`,
    ) as ScenarioWrapper<T>;
  }
}

export default Wrapper;

// playwright functions to identify fixture parameters

const signatureSymbol = Symbol('signature');
function fixtureParameterNames(fn: any) {
  if (typeof fn !== 'function') return [];
  if (!fn[signatureSymbol]) fn[signatureSymbol] = innerFixtureParameterNames(fn);
  return fn[signatureSymbol];
}
function innerFixtureParameterNames(fn: (...args: any[]) => any) {
  const text = filterOutComments(fn.toString());
  const match = text.match(/(?:async)?(?:\s+function)?[^(]*\(([^)]*)/);
  if (!match) return [];
  const trimmedParams = match[1].trim();
  if (!trimmedParams) return [];
  const [firstParam] = splitByComma(trimmedParams);
  if (firstParam[0] !== '{' || firstParam[firstParam.length - 1] !== '}') {
    return [];
  }
  const props = splitByComma(firstParam.substring(1, firstParam.length - 1)).map((prop) => {
    const colon = prop.indexOf(':');
    return colon === -1 ? prop.trim() : prop.substring(0, colon).trim();
  });
  const restProperty = props.find((prop) => prop.startsWith('...'));
  if (restProperty) {
    return [];
  }
  return props;
}
function filterOutComments(s: string) {
  const result: string[] = [];
  let commentState = 'none';
  for (let i = 0; i < s.length; ++i) {
    if (commentState === 'singleline') {
      if (s[i] === '\n') commentState = 'none';
    } else if (commentState === 'multiline') {
      if (s[i - 1] === '*' && s[i] === '/') commentState = 'none';
    } else if (commentState === 'none') {
      if (s[i] === '/' && s[i + 1] === '/') {
        commentState = 'singleline';
      } else if (s[i] === '/' && s[i + 1] === '*') {
        commentState = 'multiline';
        i += 2;
      } else {
        result.push(s[i]);
      }
    }
  }
  return result.join('');
}
function splitByComma(s: string) {
  const result: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') {
      stack.push(s[i] === '{' ? '}' : ']');
    } else if (s[i] === stack[stack.length - 1]) {
      stack.pop();
    } else if (!stack.length && s[i] === ',') {
      const token = s.substring(start, i).trim();
      if (token) result.push(token);
      start = i + 1;
    }
  }
  const lastToken = s.substring(start).trim();
  if (lastToken) result.push(lastToken);
  return result;
}
