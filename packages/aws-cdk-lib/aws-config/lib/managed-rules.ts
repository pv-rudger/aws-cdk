import { Construct } from 'constructs';
import { ManagedRule, ManagedRuleIdentifiers, ResourceType, RuleProps, RuleScope } from './rule';
import * as iam from '../../aws-iam';
import * as sns from '../../aws-sns';
import { Duration, Lazy, Stack, ValidationError } from '../../core';
import { addConstructMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';

/**
 * Construction properties for a AccessKeysRotated
 */
export interface AccessKeysRotatedProps extends RuleProps {
  /**
   * The maximum number of days within which the access keys must be rotated.
   *
   * @default Duration.days(90)
   */
  readonly maxAge?: Duration;
}

/**
 * Checks whether the active access keys are rotated within the number of days
 * specified in `maxAge`.
 *
 * @see https://docs.aws.amazon.com/config/latest/developerguide/access-keys-rotated.html
 *
 * @resource AWS::Config::ConfigRule
 */
@propertyInjectable
export class AccessKeysRotated extends ManagedRule {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-config.AccessKeysRotated';

  constructor(scope: Construct, id: string, props: AccessKeysRotatedProps = {}) {
    super(scope, id, {
      ...props,
      identifier: ManagedRuleIdentifiers.ACCESS_KEYS_ROTATED,
      inputParameters: {
        ...props.maxAge
          ? {
            maxAccessKeyAge: props.maxAge.toDays(),
          }
          : {},
      },
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);
  }
}

/**
 * Construction properties for a CloudFormationStackDriftDetectionCheck
 */
export interface CloudFormationStackDriftDetectionCheckProps extends RuleProps {
  /**
   * Whether to check only the stack where this rule is deployed.
   *
   * @default false
   */
  readonly ownStackOnly?: boolean;

  /**
   * The IAM role to use for this rule. It must have permissions to detect drift
   * for AWS CloudFormation stacks. Ensure to attach `config.amazonaws.com` trusted
   * permissions and `ReadOnlyAccess` policy permissions. For specific policy permissions,
   * refer to https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html.
   *
   * @default - A role will be created
   */
  readonly role?: iam.IRole;
}

/**
 * Checks whether your CloudFormation stacks' actual configuration differs, or
 * has drifted, from its expected configuration.
 *
 * @see https://docs.aws.amazon.com/config/latest/developerguide/cloudformation-stack-drift-detection-check.html
 *
 * @resource AWS::Config::ConfigRule
 */
@propertyInjectable
export class CloudFormationStackDriftDetectionCheck extends ManagedRule {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-config.CloudFormationStackDriftDetectionCheck';
  private readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: CloudFormationStackDriftDetectionCheckProps = {}) {
    super(scope, id, {
      ...props,
      identifier: ManagedRuleIdentifiers.CLOUDFORMATION_STACK_DRIFT_DETECTION_CHECK,
      inputParameters: {
        cloudformationRoleArn: Lazy.string({ produce: () => this.role.roleArn }),
      },
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    this.ruleScope = RuleScope.fromResource( ResourceType.CLOUDFORMATION_STACK, props.ownStackOnly ? Stack.of(this).stackId : undefined );

    this.role = props.role || new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
      ],
    });
  }
}

/**
 * Construction properties for a CloudFormationStackNotificationCheck.
 */
export interface CloudFormationStackNotificationCheckProps extends RuleProps {
  /**
   * A list of allowed topics. At most 5 topics.
   *
   * @default - No topics.
   */
  readonly topics?: sns.ITopic[];
}

/**
 * Checks whether your CloudFormation stacks are sending event notifications to
 * a SNS topic. Optionally checks whether specified SNS topics are used.
 *
 * @see https://docs.aws.amazon.com/config/latest/developerguide/cloudformation-stack-notification-check.html
 *
 * @resource AWS::Config::ConfigRule
 */
@propertyInjectable
export class CloudFormationStackNotificationCheck extends ManagedRule {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-config.CloudFormationStackNotificationCheck';

  constructor(scope: Construct, id: string, props: CloudFormationStackNotificationCheckProps = {}) {
    if (props.topics && props.topics.length > 5) {
      throw new ValidationError('At most 5 topics can be specified.', scope);
    }

    super(scope, id, {
      ...props,
      identifier: ManagedRuleIdentifiers.CLOUDFORMATION_STACK_NOTIFICATION_CHECK,
      inputParameters: props.topics && props.topics.reduce(
        (params, topic, idx) => ({ ...params, [`snsTopic${idx + 1}`]: topic.topicArn }),
        {},
      ),
      ruleScope: RuleScope.fromResources([ResourceType.CLOUDFORMATION_STACK]),
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);
  }
}
