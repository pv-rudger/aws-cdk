import { Construct } from 'constructs';
import { DynamoDBMetrics } from './dynamodb-canned-metrics.generated';
import { CfnTable, CfnTableProps } from './dynamodb.generated';
import * as perms from './perms';
import { ReplicaProvider } from './replica-provider';
import { EnableScalingProps, IScalableTableAttribute } from './scalable-attribute-api';
import { ScalableTableAttribute } from './scalable-table-attribute';
import {
  Operation, OperationsMetricOptions, SystemErrorsForOperationsMetricOptions,
  Attribute, BillingMode, ProjectionType, ITable, SecondaryIndexProps, TableClass,
  LocalSecondaryIndexProps, TableEncryption, StreamViewType, WarmThroughput, PointInTimeRecoverySpecification,
} from './shared';
import * as appscaling from '../../aws-applicationautoscaling';
import * as cloudwatch from '../../aws-cloudwatch';
import * as iam from '../../aws-iam';
import * as kinesis from '../../aws-kinesis';
import * as kms from '../../aws-kms';
import * as s3 from '../../aws-s3';
import {
  ArnFormat, Resource,
  Aws, CfnCondition, CfnCustomResource, CfnResource, Duration,
  Fn, Lazy, Names, RemovalPolicy, Stack, Token, CustomResource,
  CfnDeletionPolicy,
  FeatureFlags,
} from '../../core';
import { UnscopedValidationError, ValidationError } from '../../core/lib/errors';
import { addConstructMetadata, MethodMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';
import { DYNAMODB_TABLE_RETAIN_TABLE_REPLICA } from '../../cx-api';

const HASH_KEY_TYPE = 'HASH';
const RANGE_KEY_TYPE = 'RANGE';

// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Limits.html#limits-secondary-indexes
const MAX_LOCAL_SECONDARY_INDEX_COUNT = 5;

/**
 * Represents the table schema attributes.
 */
export interface SchemaOptions {
  /**
   * Partition key attribute definition.
   */
  readonly partitionKey: Attribute;

  /**
   * Sort key attribute definition.
   *
   * @default no sort key
   */
  readonly sortKey?: Attribute;
}

/**
 * Type of compression to use for imported data.
 */
export enum InputCompressionType {
  /**
   * GZIP compression.
   */
  GZIP = 'GZIP',

  /**
   * ZSTD compression.
   */
  ZSTD = 'ZSTD',

  /**
   * No compression.
   */
  NONE = 'NONE',
}

/**
 * The options for imported source files in CSV format.
 */
export interface CsvOptions {
  /**
   * The delimiter used for separating items in the CSV file being imported.
   *
   * Valid delimiters are as follows:
   * - comma (`,`)
   * - tab (`\t`)
   * - colon (`:`)
   * - semicolon (`;`)
   * - pipe (`|`)
   * - space (` `)
   *
   * @default - use comma as a delimiter.
   */
  readonly delimiter?: string;

  /**
   * List of the headers used to specify a common header for all source CSV files being imported.
   *
   * **NOTE**: If this field is specified then the first line of each CSV file is treated as data instead of the header.
   * If this field is not specified the the first line of each CSV file is treated as the header.
   *
   * @default - the first line of the CSV file is treated as the header
   */
  readonly headerList?: string[];
}

/**
 * The format of the source data.
 */
export abstract class InputFormat {
  /**
   * DynamoDB JSON format.
   */
  public static dynamoDBJson(): InputFormat {
    return new class extends InputFormat {
      public _render(): Pick<CfnTable.ImportSourceSpecificationProperty, 'inputFormat' | 'inputFormatOptions'> {
        return {
          inputFormat: 'DYNAMODB_JSON',
        };
      }
    }();
  }

  /**
   * Amazon Ion format.
   */
  public static ion(): InputFormat {
    return new class extends InputFormat {
      public _render(): Pick<CfnTable.ImportSourceSpecificationProperty, 'inputFormat' | 'inputFormatOptions'> {
        return {
          inputFormat: 'ION',
        };
      }
    }();
  }

  /**
   * CSV format.
   */
  public static csv(options?: CsvOptions): InputFormat {
    // We are using the .length property to check the length of the delimiter.
    // Note that .length may not return the expected result for multi-codepoint characters like full-width characters or emojis,
    // but such characters are not expected to be used as delimiters in this context.
    if (options?.delimiter && (!this.validCsvDelimiters.includes(options.delimiter) || options.delimiter.length !== 1)) {
      throw new UnscopedValidationError([
        'Delimiter must be a single character and one of the following:',
        `${this.readableValidCsvDelimiters.join(', ')},`,
        `got '${options.delimiter}'`,
      ].join(' '));
    }

    return new class extends InputFormat {
      public _render(): Pick<CfnTable.ImportSourceSpecificationProperty, 'inputFormat' | 'inputFormatOptions'> {
        return {
          inputFormat: 'CSV',
          inputFormatOptions: {
            csv: {
              delimiter: options?.delimiter,
              headerList: options?.headerList,
            },
          },
        };
      }
    }();
  }

  /**
   * Valid CSV delimiters.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-dynamodb-table-csv.html#cfn-dynamodb-table-csv-delimiter
   */
  private static validCsvDelimiters = [',', '\t', ':', ';', '|', ' '];

  private static readableValidCsvDelimiters = ['comma (,)', 'tab (\\t)', 'colon (:)', 'semicolon (;)', 'pipe (|)', 'space ( )'];

  /**
   * Render the input format and options.
   *
   * @internal
   */
  public abstract _render(): Pick<CfnTable.ImportSourceSpecificationProperty, 'inputFormat' | 'inputFormatOptions'>;
}

/**
 *  Properties for importing data from the S3.
 */
export interface ImportSourceSpecification {
  /**
   * The compression type of the imported data.
   *
   * @default InputCompressionType.NONE
   */
  readonly compressionType?: InputCompressionType;

  /**
   * The format of the imported data.
   */
  readonly inputFormat: InputFormat;

  /**
   * The S3 bucket that is being imported from.
   */
  readonly bucket: s3.IBucket;

  /**
   * The account number of the S3 bucket that is being imported from.
   *
   * @default - no value
   */
  readonly bucketOwner?: string;

  /**
   * The key prefix shared by all S3 Objects that are being imported.
   *
   * @default - no value
   */
  readonly keyPrefix?: string;
}

/**
 * The precision associated with the DynamoDB write timestamps that will be replicated to Kinesis.
 * The default setting for record timestamp precision is microseconds. You can change this setting at any time.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-dynamodb-table-kinesisstreamspecification.html#aws-properties-dynamodb-table-kinesisstreamspecification-properties
 */
export enum ApproximateCreationDateTimePrecision {
  /**
   * Millisecond precision
   */
  MILLISECOND = 'MILLISECOND',

  /**
   * Microsecond precision
   */
  MICROSECOND = 'MICROSECOND',
}

/**
 * Properties of a DynamoDB Table
 *
 * Use `TableProps` for all table properties
 */
export interface TableOptions extends SchemaOptions {
  /**
   * The read capacity for the table. Careful if you add Global Secondary Indexes, as
   * those will share the table's provisioned throughput.
   *
   * Can only be provided if billingMode is Provisioned.
   *
   * @default 5
   */
  readonly readCapacity?: number;
  /**
   * The write capacity for the table. Careful if you add Global Secondary Indexes, as
   * those will share the table's provisioned throughput.
   *
   * Can only be provided if billingMode is Provisioned.
   *
   * @default 5
   */
  readonly writeCapacity?: number;

  /**
   * The maximum read request units for the table. Careful if you add Global Secondary Indexes, as
   * those will share the table's maximum on-demand throughput.
   *
   * Can only be provided if billingMode is PAY_PER_REQUEST.
   *
   * @default - on-demand throughput is disabled
   */
  readonly maxReadRequestUnits?: number;
  /**
   * The write request units for the table. Careful if you add Global Secondary Indexes, as
   * those will share the table's maximum on-demand throughput.
   *
   * Can only be provided if billingMode is PAY_PER_REQUEST.
   *
   * @default - on-demand throughput is disabled
   */
  readonly maxWriteRequestUnits?: number;

  /**
   * Specify how you are charged for read and write throughput and how you manage capacity.
   *
   * @default PROVISIONED if `replicationRegions` is not specified, PAY_PER_REQUEST otherwise
   */
  readonly billingMode?: BillingMode;

  /**
   * Specify values to pre-warm you DynamoDB Table
   * Warm Throughput feature is not available for Global Table replicas using the `Table` construct. To enable Warm Throughput, use the `TableV2` construct instead.
   * @see http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#cfn-dynamodb-table-warmthroughput
   * @default - warm throughput is not configured
   */
  readonly warmThroughput?: WarmThroughput;

  /**
   * Whether point-in-time recovery is enabled.
   * @deprecated use `pointInTimeRecoverySpecification` instead
   * @default false - point in time recovery is not enabled.
   */
  readonly pointInTimeRecovery?: boolean;

  /**
   * Whether point-in-time recovery is enabled
   * and recoveryPeriodInDays is set.
   *
   * @default - point in time recovery is not enabled.
   */
  readonly pointInTimeRecoverySpecification?: PointInTimeRecoverySpecification;

  /**
   * Whether server-side encryption with an AWS managed customer master key is enabled.
   *
   * This property cannot be set if `encryption` and/or `encryptionKey` is set.
   *
   * @default - The table is encrypted with an encryption key managed by DynamoDB, and you are not charged any fee for using it.
   *
   * @deprecated This property is deprecated. In order to obtain the same behavior as
   * enabling this, set the `encryption` property to `TableEncryption.AWS_MANAGED` instead.
   */
  readonly serverSideEncryption?: boolean;

  /**
   * Specify the table class.
   * @default STANDARD
   */
  readonly tableClass?: TableClass;

  /**
   * Whether server-side encryption with an AWS managed customer master key is enabled.
   *
   * This property cannot be set if `serverSideEncryption` is set.
   *
   * > **NOTE**: if you set this to `CUSTOMER_MANAGED` and `encryptionKey` is not
   * > specified, the key that the Tablet generates for you will be created with
   * > default permissions. If you are using CDKv2, these permissions will be
   * > sufficient to enable the key for use with DynamoDB tables.  If you are
   * > using CDKv1, make sure the feature flag
   * > `@aws-cdk/aws-kms:defaultKeyPolicies` is set to `true` in your `cdk.json`.
   *
   * @default - The table is encrypted with an encryption key managed by DynamoDB, and you are not charged any fee for using it.
   */
  readonly encryption?: TableEncryption;

  /**
   * External KMS key to use for table encryption.
   *
   * This property can only be set if `encryption` is set to `TableEncryption.CUSTOMER_MANAGED`.
   *
   * @default - If `encryption` is set to `TableEncryption.CUSTOMER_MANAGED` and this
   * property is undefined, a new KMS key will be created and associated with this table.
   * If `encryption` and this property are both undefined, then the table is encrypted with
   * an encryption key managed by DynamoDB, and you are not charged any fee for using it.
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * The name of TTL attribute.
   * @default - TTL is disabled
   */
  readonly timeToLiveAttribute?: string;

  /**
   * When an item in the table is modified, StreamViewType determines what information
   * is written to the stream for this table.
   *
   * @default - streams are disabled unless `replicationRegions` is specified
   */
  readonly stream?: StreamViewType;

  /**
   * The removal policy to apply to the DynamoDB Table.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * The removal policy to apply to the DynamoDB replica tables.
   *
   * @default undefined - use DynamoDB Table's removal policy
   */
  readonly replicaRemovalPolicy?: RemovalPolicy;

  /**
   * Regions where replica tables will be created
   *
   * @default - no replica tables are created
   */
  readonly replicationRegions?: string[];

  /**
   * The timeout for a table replication operation in a single region.
   *
   * @default Duration.minutes(30)
   */
  readonly replicationTimeout?: Duration;

  /**
   * [WARNING: Use this flag with caution, misusing this flag may cause deleting existing replicas, refer to the detailed documentation for more information]
   * Indicates whether CloudFormation stack waits for replication to finish.
   * If set to false, the CloudFormation resource will mark the resource as
   * created and replication will be completed asynchronously. This property is
   * ignored if replicationRegions property is not set.
   *
   * WARNING:
   * DO NOT UNSET this property if adding/removing multiple replicationRegions
   * in one deployment, as CloudFormation only supports one region replication
   * at a time. CDK overcomes this limitation by waiting for replication to
   * finish before starting new replicationRegion.
   *
   * If the custom resource which handles replication has a physical resource
   * ID with the format `region` instead of `tablename-region` (this would happen
   * if the custom resource hasn't received an event since v1.91.0), DO NOT SET
   * this property to false without making a change to the table name.
   * This will cause the existing replicas to be deleted.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-globaltable.html#cfn-dynamodb-globaltable-replicas
   * @default true
   */
  readonly waitForReplicationToFinish?: boolean;

  /**
   * Whether CloudWatch contributor insights is enabled.
   *
   * @default false
   */
  readonly contributorInsightsEnabled?: boolean;

  /**
   * Enables deletion protection for the table.
   *
   * @default false
   */
  readonly deletionProtection?: boolean;

  /**
   * The properties of data being imported from the S3 bucket source to the table.
   *
   * @default - no data import from the S3 bucket
   */
  readonly importSource?: ImportSourceSpecification;

  /**
   * Resource policy to assign to table.
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#cfn-dynamodb-table-resourcepolicy
   * @default - No resource policy statement
   */
  readonly resourcePolicy?: iam.PolicyDocument;
}

/**
 * Properties for a DynamoDB Table
 */
export interface TableProps extends TableOptions {
  /**
   * Enforces a particular physical table name.
   * @default <generated>
   */
  readonly tableName?: string;

  /**
   * Kinesis Data Stream to capture item-level changes for the table.
   *
   * @default - no Kinesis Data Stream
   */
  readonly kinesisStream?: kinesis.IStream;

  /**
   * Kinesis Data Stream approximate creation timestamp precision
   *
   * @default ApproximateCreationDateTimePrecision.MICROSECOND
   */
  readonly kinesisPrecisionTimestamp?: ApproximateCreationDateTimePrecision;
}

/**
 * Properties for a global secondary index
 */
export interface GlobalSecondaryIndexProps extends SecondaryIndexProps, SchemaOptions {
  /**
   * The read capacity for the global secondary index.
   *
   * Can only be provided if table billingMode is Provisioned or undefined.
   *
   * @default 5
   */
  readonly readCapacity?: number;

  /**
   * The write capacity for the global secondary index.
   *
   * Can only be provided if table billingMode is Provisioned or undefined.
   *
   * @default 5
   */
  readonly writeCapacity?: number;

  /**
   * The maximum read request units for the global secondary index.
   *
   * Can only be provided if table billingMode is PAY_PER_REQUEST.
   *
   * @default - on-demand throughput is disabled
   */
  readonly maxReadRequestUnits?: number;

  /**
   * The maximum write request units for the global secondary index.
   *
   * Can only be provided if table billingMode is PAY_PER_REQUEST.
   *
   * @default - on-demand throughput is disabled
   */
  readonly maxWriteRequestUnits?: number;

  /**
   * The warm throughput configuration for the global secondary index.
   *
   * @default - no warm throughput is configured
   */
  readonly warmThroughput?: WarmThroughput;

  /**
   * Whether CloudWatch contributor insights is enabled for the specified global secondary index.
   *
   * @default false
   */
  readonly contributorInsightsEnabled?: boolean;
}

/**
 * Reference to a dynamodb table.
 */
export interface TableAttributes {
  /**
   * The ARN of the dynamodb table.
   * One of this, or `tableName`, is required.
   *
   * @default - no table arn
   */
  readonly tableArn?: string;

  /**
   * The table name of the dynamodb table.
   * One of this, or `tableArn`, is required.
   *
   * @default - no table name
   */
  readonly tableName?: string;

  /**
   * The ARN of the table's stream.
   *
   * @default - no table stream
   */
  readonly tableStreamArn?: string;

  /**
   * KMS encryption key, if this table uses a customer-managed encryption key.
   *
   * @default - no key
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * The name of the global indexes set for this Table.
   * Note that you need to set either this property,
   * or `localIndexes`,
   * if you want methods like grantReadData()
   * to grant permissions for indexes as well as the table itself.
   *
   * @default - no global indexes
   */
  readonly globalIndexes?: string[];

  /**
   * The name of the local indexes set for this Table.
   * Note that you need to set either this property,
   * or `globalIndexes`,
   * if you want methods like grantReadData()
   * to grant permissions for indexes as well as the table itself.
   *
   * @default - no local indexes
   */
  readonly localIndexes?: string[];

  /**
   * If set to true, grant methods always grant permissions for all indexes.
   * If false is provided, grant methods grant the permissions
   * only when `globalIndexes` or `localIndexes` is specified.
   *
   * @default - false
   */
  readonly grantIndexPermissions?: boolean;
}

export abstract class TableBase extends Resource implements ITable, iam.IResourceWithPolicy {
  /**
   * @attribute
   */
  public abstract readonly tableArn: string;

  /**
   * @attribute
   */
  public abstract readonly tableName: string;

  /**
   * @attribute
   */
  public abstract readonly tableStreamArn?: string;

  /**
   * KMS encryption key, if this table uses a customer-managed encryption key.
   */
  public abstract readonly encryptionKey?: kms.IKey;

  /**
   * Resource policy to assign to table.
   * @attribute
   */
  public abstract resourcePolicy?: iam.PolicyDocument;

  protected readonly regionalArns = new Array<string>();

  /**
   * Adds an IAM policy statement associated with this table to an IAM
   * principal's policy.
   *
   * If `encryptionKey` is present, appropriate grants to the key needs to be added
   * separately using the `table.encryptionKey.grant*` methods.
   *
   * @param grantee The principal (no-op if undefined)
   * @param actions The set of actions to allow (i.e. "dynamodb:PutItem", "dynamodb:GetItem", ...)
   */
  public grant(grantee: iam.IGrantable, ...actions: string[]): iam.Grant {
    return iam.Grant.addToPrincipalOrResource({
      grantee,
      actions,
      resourceArns: [
        this.tableArn,
        Lazy.string({ produce: () => this.hasIndex ? `${this.tableArn}/index/*` : Aws.NO_VALUE }),
        ...this.regionalArns,
        ...this.regionalArns.map(arn => Lazy.string({
          produce: () => this.hasIndex ? `${arn}/index/*` : Aws.NO_VALUE,
        })),
      ],
      resource: this,
    });
  }
  /**
   * Adds an IAM policy statement associated with this table's stream to an
   * IAM principal's policy.
   *
   * If `encryptionKey` is present, appropriate grants to the key needs to be added
   * separately using the `table.encryptionKey.grant*` methods.
   *
   * @param grantee The principal (no-op if undefined)
   * @param actions The set of actions to allow (i.e. "dynamodb:DescribeStream", "dynamodb:GetRecords", ...)
   */
  public grantStream(grantee: iam.IGrantable, ...actions: string[]): iam.Grant {
    if (!this.tableStreamArn) {
      throw new ValidationError(`DynamoDB Streams must be enabled on the table ${this.node.path}`, this);
    }

    return iam.Grant.addToPrincipal({
      grantee,
      actions,
      resourceArns: [this.tableStreamArn],
      scope: this,
    });
  }

  /**
   * Permits an IAM principal all data read operations from this table:
   * BatchGetItem, GetRecords, GetShardIterator, Query, GetItem, Scan, DescribeTable.
   *
   * Appropriate grants will also be added to the customer-managed KMS key
   * if one was configured.
   *
   * @param grantee The principal to grant access to
   */
  public grantReadData(grantee: iam.IGrantable): iam.Grant {
    const tableActions = perms.READ_DATA_ACTIONS.concat(perms.DESCRIBE_TABLE);
    return this.combinedGrant(grantee, { keyActions: perms.KEY_READ_ACTIONS, tableActions });
  }

  /**
   * Permits an IAM Principal to list streams attached to current dynamodb table.
   *
   * @param grantee The principal (no-op if undefined)
   */
  public grantTableListStreams(grantee: iam.IGrantable): iam.Grant {
    if (!this.tableStreamArn) {
      throw new ValidationError(`DynamoDB Streams must be enabled on the table ${this.node.path}`, this);
    }

    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['dynamodb:ListStreams'],
      resourceArns: ['*'],
    });
  }

  /**
   * Permits an IAM principal all stream data read operations for this
   * table's stream:
   * DescribeStream, GetRecords, GetShardIterator, ListStreams.
   *
   * Appropriate grants will also be added to the customer-managed KMS key
   * if one was configured.
   *
   * @param grantee The principal to grant access to
   */
  public grantStreamRead(grantee: iam.IGrantable): iam.Grant {
    this.grantTableListStreams(grantee);
    return this.combinedGrant(grantee, { keyActions: perms.KEY_READ_ACTIONS, streamActions: perms.READ_STREAM_DATA_ACTIONS });
  }

  /**
   * Permits an IAM principal all data write operations to this table:
   * BatchWriteItem, PutItem, UpdateItem, DeleteItem, DescribeTable.
   *
   * Appropriate grants will also be added to the customer-managed KMS key
   * if one was configured.
   *
   * @param grantee The principal to grant access to
   */
  public grantWriteData(grantee: iam.IGrantable): iam.Grant {
    const tableActions = perms.WRITE_DATA_ACTIONS.concat(perms.DESCRIBE_TABLE);
    const keyActions = perms.KEY_READ_ACTIONS.concat(perms.KEY_WRITE_ACTIONS);
    return this.combinedGrant(grantee, { keyActions, tableActions });
  }

  /**
   * Permits an IAM principal to all data read/write operations to this table.
   * BatchGetItem, GetRecords, GetShardIterator, Query, GetItem, Scan,
   * BatchWriteItem, PutItem, UpdateItem, DeleteItem, DescribeTable
   *
   * Appropriate grants will also be added to the customer-managed KMS key
   * if one was configured.
   *
   * @param grantee The principal to grant access to
   */
  public grantReadWriteData(grantee: iam.IGrantable): iam.Grant {
    const tableActions = perms.READ_DATA_ACTIONS.concat(perms.WRITE_DATA_ACTIONS).concat(perms.DESCRIBE_TABLE);
    const keyActions = perms.KEY_READ_ACTIONS.concat(perms.KEY_WRITE_ACTIONS);
    return this.combinedGrant(grantee, { keyActions, tableActions });
  }

  /**
   * Permits all DynamoDB operations ("dynamodb:*") to an IAM principal.
   *
   * Appropriate grants will also be added to the customer-managed KMS key
   * if one was configured.
   *
   * @param grantee The principal to grant access to
   */
  public grantFullAccess(grantee: iam.IGrantable) {
    const keyActions = perms.KEY_READ_ACTIONS.concat(perms.KEY_WRITE_ACTIONS);
    return this.combinedGrant(grantee, { keyActions, tableActions: ['dynamodb:*'] });
  }

  /**
   * Adds a statement to the resource policy associated with this file system.
   * A resource policy will be automatically created upon the first call to `addToResourcePolicy`.
   *
   * Note that this does not work with imported file systems.
   *
   * @param statement The policy statement to add
   */
  public addToResourcePolicy(statement: iam.PolicyStatement): iam.AddToResourcePolicyResult {
    this.resourcePolicy = this.resourcePolicy ?? new iam.PolicyDocument({ statements: [] });
    this.resourcePolicy.addStatements(statement);
    return {
      statementAdded: true,
      policyDependable: this,
    };
  }

  /**
   * Return the given named metric for this Table
   *
   * By default, the metric will be calculated as a sum over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metric(metricName: string, props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/DynamoDB',
      metricName,
      dimensionsMap: {
        TableName: this.tableName,
      },
      ...props,
    }).attachTo(this);
  }

  /**
   * Metric for the consumed read capacity units this table
   *
   * By default, the metric will be calculated as a sum over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metricConsumedReadCapacityUnits(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.cannedMetric(DynamoDBMetrics.consumedReadCapacityUnitsSum, props);
  }

  /**
   * Metric for the consumed write capacity units this table
   *
   * By default, the metric will be calculated as a sum over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metricConsumedWriteCapacityUnits(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.cannedMetric(DynamoDBMetrics.consumedWriteCapacityUnitsSum, props);
  }

  /**
   * Metric for the system errors this table
   *
   * @deprecated use `metricSystemErrorsForOperations`.
   */
  public metricSystemErrors(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    if (!props?.dimensions?.Operation && !props?.dimensionsMap?.Operation) {
      // 'Operation' must be passed because its an operational metric.
      throw new ValidationError("'Operation' dimension must be passed for the 'SystemErrors' metric.", this);
    }

    const dimensionsMap = {
      TableName: this.tableName,
      ...props?.dimensions ?? {},
      ...props?.dimensionsMap ?? {},
    };

    return this.metric('SystemErrors', { statistic: 'sum', ...props, dimensionsMap });
  }

  /**
   * Metric for the user errors. Note that this metric reports user errors across all
   * the tables in the account and region the table resides in.
   *
   * By default, the metric will be calculated as a sum over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metricUserErrors(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    if (props?.dimensions) {
      throw new ValidationError("'dimensions' is not supported for the 'UserErrors' metric", this);
    }

    // overriding 'dimensions' here because this metric is an account metric.
    // see 'UserErrors' in https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html
    return this.metric('UserErrors', { statistic: 'sum', ...props, dimensionsMap: {} });
  }

  /**
   * Metric for the conditional check failed requests this table
   *
   * By default, the metric will be calculated as a sum over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metricConditionalCheckFailedRequests(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.metric('ConditionalCheckFailedRequests', { statistic: 'sum', ...props });
  }

  /**
   * How many requests are throttled on this table
   *
   * Default: sum over 5 minutes
   *
   * @deprecated Do not use this function. It returns an invalid metric. Use `metricThrottledRequestsForOperation` instead.
   */
  public metricThrottledRequests(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return this.metric('ThrottledRequests', { statistic: 'sum', ...props });
  }

  /**
   * Metric for the successful request latency this table.
   *
   * By default, the metric will be calculated as an average over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metricSuccessfulRequestLatency(props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    if (!props?.dimensions?.Operation && !props?.dimensionsMap?.Operation) {
      throw new ValidationError("'Operation' dimension must be passed for the 'SuccessfulRequestLatency' metric.", this);
    }

    const dimensionsMap = {
      TableName: this.tableName,
      Operation: props.dimensionsMap?.Operation ?? props.dimensions?.Operation,
    };

    return new cloudwatch.Metric({
      ...DynamoDBMetrics.successfulRequestLatencyAverage(dimensionsMap),
      ...props,
      dimensionsMap,
    }).attachTo(this);
  }

  /**
   * How many requests are throttled on this table, for the given operation
   *
   * Default: sum over 5 minutes
   */
  public metricThrottledRequestsForOperation(operation: string, props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return new cloudwatch.Metric({
      ...DynamoDBMetrics.throttledRequestsSum({ Operation: operation, TableName: this.tableName }),
      ...props,
    }).attachTo(this);
  }

  /**
   * How many requests are throttled on this table.
   *
   * This will sum errors across all possible operations.
   * Note that by default, each individual metric will be calculated as a sum over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metricThrottledRequestsForOperations(props?: OperationsMetricOptions): cloudwatch.IMetric {
    return this.sumMetricsForOperations('ThrottledRequests', 'Sum of throttled requests across all operations', props);
  }

  /**
   * Metric for the system errors this table.
   *
   * This will sum errors across all possible operations.
   * Note that by default, each individual metric will be calculated as a sum over a period of 5 minutes.
   * You can customize this by using the `statistic` and `period` properties.
   */
  public metricSystemErrorsForOperations(props?: SystemErrorsForOperationsMetricOptions): cloudwatch.IMetric {
    return this.sumMetricsForOperations('SystemErrors', 'Sum of errors across all operations', props);
  }

  /**
   * Create a math expression for operations.
   *
   * @param metricName The metric name.
   * @param expressionLabel Label for expression
   * @param props operation list
   */
  private sumMetricsForOperations(metricName: string, expressionLabel: string, props?: OperationsMetricOptions): cloudwatch.IMetric {
    if (props?.dimensions?.Operation) {
      throw new ValidationError("The Operation dimension is not supported. Use the 'operations' property.", this);
    }

    const operations = props?.operations ?? Object.values(Operation);

    const values = this.createMetricsForOperations(metricName, operations, { statistic: 'sum', ...props });

    const sum = new cloudwatch.MathExpression({
      expression: `${Object.keys(values).join(' + ')}`,
      usingMetrics: { ...values },
      color: props?.color,
      label: expressionLabel,
      period: props?.period,
    });

    return sum;
  }

  /**
   * Create a map of metrics that can be used in a math expression.
   *
   * Using the return value of this function as the `usingMetrics` property in `cloudwatch.MathExpression` allows you to
   * use the keys of this map as metric names inside you expression.
   *
   * @param metricName The metric name.
   * @param operations The list of operations to create metrics for.
   * @param props Properties for the individual metrics.
   * @param metricNameMapper Mapper function to allow controlling the individual metric name per operation.
   */
  private createMetricsForOperations(metricName: string, operations: Operation[],
    props?: cloudwatch.MetricOptions, metricNameMapper?: (op: Operation) => string): Record<string, cloudwatch.IMetric> {
    const metrics: Record<string, cloudwatch.IMetric> = {};

    const mapper = metricNameMapper ?? (op => op.toLowerCase());

    if (props?.dimensions?.Operation) {
      throw new ValidationError('Invalid properties. Operation dimension is not supported when calculating operational metrics', this);
    }

    for (const operation of operations) {
      const metric = this.metric(metricName, {
        ...props,
        dimensionsMap: {
          TableName: this.tableName,
          Operation: operation,
          ...props?.dimensions,
        },
      });

      const operationMetricName = mapper(operation);
      const firstChar = operationMetricName.charAt(0);

      if (firstChar === firstChar.toUpperCase()) {
        // https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/using-metric-math.html#metric-math-syntax
        throw new ValidationError(`Mapper generated an illegal operation metric name: ${operationMetricName}. Must start with a lowercase letter`, this);
      }

      metrics[operationMetricName] = metric;
    }

    return metrics;
  }

  protected abstract get hasIndex(): boolean;

  /**
   * Adds an IAM policy statement associated with this table to an IAM
   * principal's policy.
   * @param grantee The principal (no-op if undefined)
   * @param opts Options for keyActions, tableActions and streamActions
   */
  private combinedGrant(
    grantee: iam.IGrantable,
    opts: { keyActions?: string[]; tableActions?: string[]; streamActions?: string[] },
  ): iam.Grant {
    if (this.encryptionKey && opts.keyActions) {
      this.encryptionKey.grant(grantee, ...opts.keyActions);
    }
    if (opts.tableActions) {
      const resources = [
        this.tableArn,
        Lazy.string({ produce: () => this.hasIndex ? `${this.tableArn}/index/*` : Aws.NO_VALUE }),
        ...this.regionalArns,
        ...this.regionalArns.map(arn => Lazy.string({
          produce: () => this.hasIndex ? `${arn}/index/*` : Aws.NO_VALUE,
        })),
      ];
      const ret = iam.Grant.addToPrincipalOrResource({
        grantee,
        actions: opts.tableActions,
        resourceArns: resources,
        resource: this,
      });
      return ret;
    }
    if (opts.streamActions) {
      if (!this.tableStreamArn) {
        throw new ValidationError(`DynamoDB Streams must be enabled on the table ${this.node.path}`, this);
      }
      const resources = [this.tableStreamArn];
      const ret = iam.Grant.addToPrincipalOrResource({
        grantee,
        actions: opts.streamActions,
        resourceArns: resources,
        resource: this,
      });
      return ret;
    }
    throw new ValidationError(`Unexpected 'action', ${opts.tableActions || opts.streamActions}`, this);
  }

  private cannedMetric(
    fn: (dims: { TableName: string }) => cloudwatch.MetricProps,
    props?: cloudwatch.MetricOptions): cloudwatch.Metric {
    return new cloudwatch.Metric({
      ...fn({ TableName: this.tableName }),
      ...props,
    }).attachTo(this);
  }
}

/**
 * Provides a DynamoDB table.
 */
@propertyInjectable
export class Table extends TableBase {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-dynamodb.Table';

  /**
   * Permits an IAM Principal to list all DynamoDB Streams.
   * @deprecated Use `#grantTableListStreams` for more granular permission
   * @param grantee The principal (no-op if undefined)
   */
  public static grantListStreams(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['dynamodb:ListStreams'],
      resourceArns: ['*'],
    });
  }

  /**
   * Creates a Table construct that represents an external table via table name.
   *
   * @param scope The parent creating construct (usually `this`).
   * @param id The construct's name.
   * @param tableName The table's name.
   */
  public static fromTableName(scope: Construct, id: string, tableName: string): ITable {
    return Table.fromTableAttributes(scope, id, { tableName });
  }

  /**
   * Creates a Table construct that represents an external table via table arn.
   *
   * @param scope The parent creating construct (usually `this`).
   * @param id The construct's name.
   * @param tableArn The table's ARN.
   */
  public static fromTableArn(scope: Construct, id: string, tableArn: string): ITable {
    return Table.fromTableAttributes(scope, id, { tableArn });
  }

  /**
   * Creates a Table construct that represents an external table.
   *
   * @param scope The parent creating construct (usually `this`).
   * @param id The construct's name.
   * @param attrs A `TableAttributes` object.
   */
  public static fromTableAttributes(scope: Construct, id: string, attrs: TableAttributes): ITable {
    class Import extends TableBase {
      public readonly tableName: string;
      public readonly tableArn: string;
      public readonly tableStreamArn?: string;
      public readonly encryptionKey?: kms.IKey;
      public resourcePolicy?: iam.PolicyDocument;
      protected readonly hasIndex = (attrs.grantIndexPermissions ?? false) ||
        (attrs.globalIndexes ?? []).length > 0 ||
        (attrs.localIndexes ?? []).length > 0;

      constructor(_tableArn: string, tableName: string, tableStreamArn?: string) {
        super(scope, id);
        this.tableArn = _tableArn;
        this.tableName = tableName;
        this.tableStreamArn = tableStreamArn;
        this.encryptionKey = attrs.encryptionKey;
      }
    }

    let name: string;
    let arn: string;
    const stack = Stack.of(scope);
    if (!attrs.tableName) {
      if (!attrs.tableArn) {
        throw new ValidationError('One of tableName or tableArn is required!', scope);
      }

      arn = attrs.tableArn;
      const maybeTableName = stack.splitArn(attrs.tableArn, ArnFormat.SLASH_RESOURCE_NAME).resourceName;
      if (!maybeTableName) {
        throw new ValidationError('ARN for DynamoDB table must be in the form: ...', scope);
      }
      name = maybeTableName;
    } else {
      if (attrs.tableArn) {
        throw new ValidationError('Only one of tableArn or tableName can be provided', scope);
      }
      name = attrs.tableName;
      arn = stack.formatArn({
        service: 'dynamodb',
        resource: 'table',
        resourceName: attrs.tableName,
      });
    }

    return new Import(arn, name, attrs.tableStreamArn);
  }

  public readonly encryptionKey?: kms.IKey;

  /**
   * Resource policy to assign to DynamoDB Table.
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-dynamodb-table-resourcepolicy.html
   * @default - No resource policy statements are added to the created table.
   */
  public resourcePolicy?: iam.PolicyDocument;

  /**
   * @attribute
   */
  public readonly tableArn: string;

  /**
   * @attribute
   */
  public readonly tableName: string;

  /**
   * @attribute
   */
  public readonly tableStreamArn: string | undefined;

  private readonly table: CfnTable;

  private readonly keySchema = new Array<CfnTable.KeySchemaProperty>();
  private readonly attributeDefinitions = new Array<CfnTable.AttributeDefinitionProperty>();
  private readonly globalSecondaryIndexes = new Array<CfnTable.GlobalSecondaryIndexProperty>();
  private readonly localSecondaryIndexes = new Array<CfnTable.LocalSecondaryIndexProperty>();

  private readonly secondaryIndexSchemas = new Map<string, SchemaOptions>();
  private readonly nonKeyAttributes = new Set<string>();

  private readonly tablePartitionKey: Attribute;
  private readonly tableSortKey?: Attribute;

  private readonly billingMode: BillingMode;
  private readonly tableScaling: ScalableAttributePair = {};
  private readonly indexScaling = new Map<string, ScalableAttributePair>();
  private readonly scalingRole: iam.IRole;

  private readonly globalReplicaCustomResources = new Array<CustomResource>();

  constructor(scope: Construct, id: string, props: TableProps) {
    super(scope, id, {
      physicalName: props.tableName,
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    const { sseSpecification, encryptionKey } = this.parseEncryption(props);

    const pointInTimeRecoverySpecification = this.validatePitr(props);

    let streamSpecification: CfnTable.StreamSpecificationProperty | undefined;
    if (props.replicationRegions) {
      if (props.stream && props.stream !== StreamViewType.NEW_AND_OLD_IMAGES) {
        throw new ValidationError('`stream` must be set to `NEW_AND_OLD_IMAGES` when specifying `replicationRegions`', this);
      }
      streamSpecification = { streamViewType: StreamViewType.NEW_AND_OLD_IMAGES };

      this.billingMode = props.billingMode ?? BillingMode.PAY_PER_REQUEST;
    } else {
      this.billingMode = props.billingMode ?? BillingMode.PROVISIONED;
      if (props.stream) {
        streamSpecification = { streamViewType: props.stream };
      }
    }
    this.validateProvisioning(props);

    const kinesisStreamSpecification = props.kinesisStream
      ? {
        streamArn: props.kinesisStream.streamArn,
        ...(props.kinesisPrecisionTimestamp && { approximateCreationDateTimePrecision: props.kinesisPrecisionTimestamp }),
      }
      : undefined;

    this.table = new CfnTable(this, 'Resource', {
      tableName: this.physicalName,
      keySchema: this.keySchema,
      attributeDefinitions: this.attributeDefinitions,
      globalSecondaryIndexes: Lazy.any({ produce: () => this.globalSecondaryIndexes }, { omitEmptyArray: true }),
      localSecondaryIndexes: Lazy.any({ produce: () => this.localSecondaryIndexes }, { omitEmptyArray: true }),
      pointInTimeRecoverySpecification: pointInTimeRecoverySpecification,
      billingMode: this.billingMode === BillingMode.PAY_PER_REQUEST ? this.billingMode : undefined,
      provisionedThroughput: this.billingMode === BillingMode.PAY_PER_REQUEST ? undefined : {
        readCapacityUnits: props.readCapacity || 5,
        writeCapacityUnits: props.writeCapacity || 5,
      },
      ...(props.maxReadRequestUnits || props.maxWriteRequestUnits ?
        {
          onDemandThroughput: this.billingMode === BillingMode.PROVISIONED ? undefined : {
            maxReadRequestUnits: props.maxReadRequestUnits || undefined,
            maxWriteRequestUnits: props.maxWriteRequestUnits || undefined,
          },
        } : undefined),
      sseSpecification,
      streamSpecification,
      tableClass: props.tableClass,
      timeToLiveSpecification: props.timeToLiveAttribute ? { attributeName: props.timeToLiveAttribute, enabled: true } : undefined,
      contributorInsightsSpecification: props.contributorInsightsEnabled !== undefined ? { enabled: props.contributorInsightsEnabled } : undefined,
      kinesisStreamSpecification: kinesisStreamSpecification,
      deletionProtectionEnabled: props.deletionProtection,
      importSourceSpecification: this.renderImportSourceSpecification(props.importSource),
      resourcePolicy: props.resourcePolicy
        ? { policyDocument: props.resourcePolicy }
        : undefined,
      warmThroughput: props.warmThroughput?? undefined,
    });
    this.table.applyRemovalPolicy(props.removalPolicy);

    this.encryptionKey = encryptionKey;

    this.tableArn = this.getResourceArnAttribute(this.table.attrArn, {
      service: 'dynamodb',
      resource: 'table',
      resourceName: this.physicalName,
    });
    this.tableName = this.getResourceNameAttribute(this.table.ref);

    if (props.tableName) { this.node.addMetadata('aws:cdk:hasPhysicalName', this.tableName); }

    this.tableStreamArn = streamSpecification ? this.table.attrStreamArn : undefined;

    this.scalingRole = this.makeScalingRole();

    this.addKey(props.partitionKey, HASH_KEY_TYPE);
    this.tablePartitionKey = props.partitionKey;

    if (props.sortKey) {
      this.addKey(props.sortKey, RANGE_KEY_TYPE);
      this.tableSortKey = props.sortKey;
    }

    if (props.replicationRegions && props.replicationRegions.length > 0) {
      this.createReplicaTables(props.replicationRegions, props.replicationTimeout, props.waitForReplicationToFinish, props.replicaRemovalPolicy);
    }

    this.node.addValidation({ validate: () => this.validateTable() });
  }

  /**
   * Add a global secondary index of table.
   *
   * @param props the property of global secondary index
   */
  @MethodMetadata()
  public addGlobalSecondaryIndex(props: GlobalSecondaryIndexProps) {
    this.validateProvisioning(props);
    this.validateIndexName(props.indexName);

    // build key schema and projection for index
    const gsiKeySchema = this.buildIndexKeySchema(props.partitionKey, props.sortKey);
    const gsiProjection = this.buildIndexProjection(props);

    this.globalSecondaryIndexes.push({
      contributorInsightsSpecification: props.contributorInsightsEnabled !== undefined ? { enabled: props.contributorInsightsEnabled } : undefined,
      indexName: props.indexName,
      keySchema: gsiKeySchema,
      projection: gsiProjection,
      provisionedThroughput: this.billingMode === BillingMode.PAY_PER_REQUEST ? undefined : {
        readCapacityUnits: props.readCapacity || 5,
        writeCapacityUnits: props.writeCapacity || 5,
      },
      ...(props.maxReadRequestUnits || props.maxWriteRequestUnits ?
        {
          onDemandThroughput: this.billingMode === BillingMode.PROVISIONED ? undefined : {
            maxReadRequestUnits: props.maxReadRequestUnits || undefined,
            maxWriteRequestUnits: props.maxWriteRequestUnits || undefined,
          },
        } : undefined),
      warmThroughput: props.warmThroughput ?? undefined,
    });

    this.secondaryIndexSchemas.set(props.indexName, {
      partitionKey: props.partitionKey,
      sortKey: props.sortKey,
    });

    this.indexScaling.set(props.indexName, {});
  }

  /**
   * Add a local secondary index of table.
   *
   * @param props the property of local secondary index
   */
  @MethodMetadata()
  public addLocalSecondaryIndex(props: LocalSecondaryIndexProps) {
    // https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Limits.html#limits-secondary-indexes
    if (this.localSecondaryIndexes.length >= MAX_LOCAL_SECONDARY_INDEX_COUNT) {
      throw new RangeError(`a maximum number of local secondary index per table is ${MAX_LOCAL_SECONDARY_INDEX_COUNT}`);
    }

    this.validateIndexName(props.indexName);

    // build key schema and projection for index
    const lsiKeySchema = this.buildIndexKeySchema(this.tablePartitionKey, props.sortKey);
    const lsiProjection = this.buildIndexProjection(props);

    this.localSecondaryIndexes.push({
      indexName: props.indexName,
      keySchema: lsiKeySchema,
      projection: lsiProjection,
    });

    this.secondaryIndexSchemas.set(props.indexName, {
      partitionKey: this.tablePartitionKey,
      sortKey: props.sortKey,
    });
  }

  /**
   * Enable read capacity scaling for this table
   *
   * @returns An object to configure additional AutoScaling settings
   */
  @MethodMetadata()
  public autoScaleReadCapacity(props: EnableScalingProps): IScalableTableAttribute {
    if (this.tableScaling.scalableReadAttribute) {
      throw new ValidationError('Read AutoScaling already enabled for this table', this);
    }
    if (this.billingMode === BillingMode.PAY_PER_REQUEST) {
      throw new ValidationError('AutoScaling is not available for tables with PAY_PER_REQUEST billing mode', this);
    }

    return this.tableScaling.scalableReadAttribute = new ScalableTableAttribute(this, 'ReadScaling', {
      serviceNamespace: appscaling.ServiceNamespace.DYNAMODB,
      resourceId: `table/${this.tableName}`,
      dimension: 'dynamodb:table:ReadCapacityUnits',
      role: this.scalingRole,
      ...props,
    });
  }

  /**
   * Enable write capacity scaling for this table
   *
   * @returns An object to configure additional AutoScaling settings for this attribute
   */
  @MethodMetadata()
  public autoScaleWriteCapacity(props: EnableScalingProps): IScalableTableAttribute {
    if (this.tableScaling.scalableWriteAttribute) {
      throw new ValidationError('Write AutoScaling already enabled for this table', this);
    }
    if (this.billingMode === BillingMode.PAY_PER_REQUEST) {
      throw new ValidationError('AutoScaling is not available for tables with PAY_PER_REQUEST billing mode', this);
    }

    this.tableScaling.scalableWriteAttribute = new ScalableTableAttribute(this, 'WriteScaling', {
      serviceNamespace: appscaling.ServiceNamespace.DYNAMODB,
      resourceId: `table/${this.tableName}`,
      dimension: 'dynamodb:table:WriteCapacityUnits',
      role: this.scalingRole,
      ...props,
    });
    for (const globalReplicaCustomResource of this.globalReplicaCustomResources) {
      globalReplicaCustomResource.node.addDependency(this.tableScaling.scalableWriteAttribute);
    }
    return this.tableScaling.scalableWriteAttribute;
  }

  /**
   * Enable read capacity scaling for the given GSI
   *
   * @returns An object to configure additional AutoScaling settings for this attribute
   */
  @MethodMetadata()
  public autoScaleGlobalSecondaryIndexReadCapacity(indexName: string, props: EnableScalingProps): IScalableTableAttribute {
    if (this.billingMode === BillingMode.PAY_PER_REQUEST) {
      throw new ValidationError('AutoScaling is not available for tables with PAY_PER_REQUEST billing mode', this);
    }
    const attributePair = this.indexScaling.get(indexName);
    if (!attributePair) {
      throw new ValidationError(`No global secondary index with name ${indexName}`, this);
    }
    if (attributePair.scalableReadAttribute) {
      throw new ValidationError('Read AutoScaling already enabled for this index', this);
    }

    return attributePair.scalableReadAttribute = new ScalableTableAttribute(this, `${indexName}ReadScaling`, {
      serviceNamespace: appscaling.ServiceNamespace.DYNAMODB,
      resourceId: `table/${this.tableName}/index/${indexName}`,
      dimension: 'dynamodb:index:ReadCapacityUnits',
      role: this.scalingRole,
      ...props,
    });
  }

  /**
   * Enable write capacity scaling for the given GSI
   *
   * @returns An object to configure additional AutoScaling settings for this attribute
   */
  @MethodMetadata()
  public autoScaleGlobalSecondaryIndexWriteCapacity(indexName: string, props: EnableScalingProps): IScalableTableAttribute {
    if (this.billingMode === BillingMode.PAY_PER_REQUEST) {
      throw new ValidationError('AutoScaling is not available for tables with PAY_PER_REQUEST billing mode', this);
    }
    const attributePair = this.indexScaling.get(indexName);
    if (!attributePair) {
      throw new ValidationError(`No global secondary index with name ${indexName}`, this);
    }
    if (attributePair.scalableWriteAttribute) {
      throw new ValidationError('Write AutoScaling already enabled for this index', this);
    }

    return attributePair.scalableWriteAttribute = new ScalableTableAttribute(this, `${indexName}WriteScaling`, {
      serviceNamespace: appscaling.ServiceNamespace.DYNAMODB,
      resourceId: `table/${this.tableName}/index/${indexName}`,
      dimension: 'dynamodb:index:WriteCapacityUnits',
      role: this.scalingRole,
      ...props,
    });
  }

  /**
   * Get schema attributes of table or index.
   *
   * @returns Schema of table or index.
   */
  @MethodMetadata()
  public schema(indexName?: string): SchemaOptions {
    if (!indexName) {
      return {
        partitionKey: this.tablePartitionKey,
        sortKey: this.tableSortKey,
      };
    }
    let schema = this.secondaryIndexSchemas.get(indexName);
    if (!schema) {
      throw new ValidationError(`Cannot find schema for index: ${indexName}. Use 'addGlobalSecondaryIndex' or 'addLocalSecondaryIndex' to add index`, this);
    }
    return schema;
  }

  /**
   * Validate the table construct.
   *
   * @returns an array of validation error message
   */
  private validateTable(): string[] {
    const errors = new Array<string>();

    if (!this.tablePartitionKey) {
      errors.push('a partition key must be specified');
    }
    if (this.localSecondaryIndexes.length > 0 && !this.tableSortKey) {
      errors.push('a sort key of the table must be specified to add local secondary indexes');
    }

    if (this.globalReplicaCustomResources.length > 0 && this.billingMode === BillingMode.PROVISIONED) {
      const writeAutoScaleAttribute = this.tableScaling.scalableWriteAttribute;
      if (!writeAutoScaleAttribute) {
        errors.push('A global Table that uses PROVISIONED as the billing mode needs auto-scaled write capacity. ' +
          'Use the autoScaleWriteCapacity() method to enable it.');
      } else if (!writeAutoScaleAttribute._scalingPolicyCreated) {
        errors.push('A global Table that uses PROVISIONED as the billing mode needs auto-scaled write capacity with a policy. ' +
          'Call one of the scaleOn*() methods of the object returned from autoScaleWriteCapacity()');
      }
    }

    return errors;
  }

  /**
   * Validate read and write capacity are not specified for on-demand tables (billing mode PAY_PER_REQUEST).
   *
   * @param props read and write capacity properties
   */
  private validateProvisioning(props: { readCapacity?: number; writeCapacity?: number }): void {
    if (this.billingMode === BillingMode.PAY_PER_REQUEST) {
      if (props.readCapacity !== undefined || props.writeCapacity !== undefined) {
        throw new ValidationError('you cannot provision read and write capacity for a table with PAY_PER_REQUEST billing mode', this);
      }
    }
  }

  /**
   * Validate index name to check if a duplicate name already exists.
   *
   * @param indexName a name of global or local secondary index
   */
  private validateIndexName(indexName: string) {
    if (this.secondaryIndexSchemas.has(indexName)) {
      // a duplicate index name causes validation exception, status code 400, while trying to create CFN stack
      throw new ValidationError(`a duplicate index name, ${indexName}, is not allowed`, this);
    }
  }

  /**
   * Validate non-key attributes by checking limits within secondary index, which may vary in future.
   *
   * @param nonKeyAttributes a list of non-key attribute names
   */
  private validateNonKeyAttributes(nonKeyAttributes: string[]) {
    if (this.nonKeyAttributes.size + nonKeyAttributes.length > 100) {
      // https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Limits.html#limits-secondary-indexes
      throw new RangeError('a maximum number of nonKeyAttributes across all of secondary indexes is 100');
    }

    // store all non-key attributes
    nonKeyAttributes.forEach(att => this.nonKeyAttributes.add(att));
  }

  private validatePitr (props: TableProps): PointInTimeRecoverySpecification | undefined {
    if (props.pointInTimeRecoverySpecification !==undefined && props.pointInTimeRecovery !== undefined) {
      throw new ValidationError('`pointInTimeRecoverySpecification` and `pointInTimeRecovery` are set. Use `pointInTimeRecoverySpecification` only.', this);
    }

    const recoveryPeriodInDays = props.pointInTimeRecoverySpecification?.recoveryPeriodInDays;

    if (!props.pointInTimeRecoverySpecification?.pointInTimeRecoveryEnabled && recoveryPeriodInDays) {
      throw new ValidationError('Cannot set `recoveryPeriodInDays` while `pointInTimeRecoveryEnabled` is set to false.', this);
    }

    if (recoveryPeriodInDays !== undefined && (recoveryPeriodInDays < 1 || recoveryPeriodInDays > 35 )) {
      throw new ValidationError('`recoveryPeriodInDays` must be a value between `1` and `35`.', this);
    }

    return props.pointInTimeRecoverySpecification ??
      (props.pointInTimeRecovery !== undefined
        ? { pointInTimeRecoveryEnabled: props.pointInTimeRecovery }
        : undefined);
  }

  private buildIndexKeySchema(partitionKey: Attribute, sortKey?: Attribute): CfnTable.KeySchemaProperty[] {
    this.registerAttribute(partitionKey);
    const indexKeySchema: CfnTable.KeySchemaProperty[] = [
      { attributeName: partitionKey.name, keyType: HASH_KEY_TYPE },
    ];

    if (sortKey) {
      this.registerAttribute(sortKey);
      indexKeySchema.push({ attributeName: sortKey.name, keyType: RANGE_KEY_TYPE });
    }

    return indexKeySchema;
  }

  private buildIndexProjection(props: SecondaryIndexProps): CfnTable.ProjectionProperty {
    if (props.projectionType === ProjectionType.INCLUDE && !props.nonKeyAttributes) {
      // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-dynamodb-projectionobject.html
      throw new ValidationError(`non-key attributes should be specified when using ${ProjectionType.INCLUDE} projection type`, this);
    }

    if (props.projectionType !== ProjectionType.INCLUDE && props.nonKeyAttributes) {
      // this combination causes validation exception, status code 400, while trying to create CFN stack
      throw new ValidationError(`non-key attributes should not be specified when not using ${ProjectionType.INCLUDE} projection type`, this);
    }

    if (props.nonKeyAttributes) {
      this.validateNonKeyAttributes(props.nonKeyAttributes);
    }

    return {
      projectionType: props.projectionType ?? ProjectionType.ALL,
      nonKeyAttributes: props.nonKeyAttributes ?? undefined,
    };
  }

  private findKey(keyType: string) {
    return this.keySchema.find(prop => prop.keyType === keyType);
  }

  private addKey(attribute: Attribute, keyType: string) {
    const existingProp = this.findKey(keyType);
    if (existingProp) {
      throw new ValidationError(`Unable to set ${attribute.name} as a ${keyType} key, because ${existingProp.attributeName} is a ${keyType} key`, this);
    }
    this.registerAttribute(attribute);
    this.keySchema.push({
      attributeName: attribute.name,
      keyType,
    });
    return this;
  }

  /**
   * Register the key attribute of table or secondary index to assemble attribute definitions of TableResourceProps.
   *
   * @param attribute the key attribute of table or secondary index
   */
  private registerAttribute(attribute: Attribute) {
    const { name, type } = attribute;
    const existingDef = this.attributeDefinitions.find(def => def.attributeName === name);
    if (existingDef && existingDef.attributeType !== type) {
      throw new ValidationError(`Unable to specify ${name} as ${type} because it was already defined as ${existingDef.attributeType}`, this);
    }
    if (!existingDef) {
      this.attributeDefinitions.push({
        attributeName: name,
        attributeType: type,
      });
    }
  }

  /**
   * Return the role that will be used for AutoScaling
   */
  private makeScalingRole(): iam.IRole {
    // Use a Service Linked Role.
    // https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-service-linked-roles.html
    return iam.Role.fromRoleArn(this, 'ScalingRole', Stack.of(this).formatArn({
      service: 'iam',
      region: '',
      resource: 'role/aws-service-role/dynamodb.application-autoscaling.amazonaws.com',
      resourceName: 'AWSServiceRoleForApplicationAutoScaling_DynamoDBTable',
    }));
  }

  /**
   * Creates replica tables
   *
   * @param regions regions where to create tables
   */
  private createReplicaTables(regions: string[], timeout?: Duration, waitForReplicationToFinish?: boolean, replicaRemovalPolicy?: RemovalPolicy) {
    const stack = Stack.of(this);

    if (!Token.isUnresolved(stack.region) && regions.includes(stack.region)) {
      throw new ValidationError('`replicationRegions` cannot include the region where this stack is deployed.', this);
    }

    const provider = ReplicaProvider.getOrCreate(this, { tableName: this.tableName, regions, timeout });

    // Documentation at https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2gt_IAM.html
    // is currently incorrect. AWS Support recommends `dynamodb:*` in both source and destination regions

    const onEventHandlerPolicy = new SourceTableAttachedPolicy(this, provider.onEventHandler.role!);
    const isCompleteHandlerPolicy = new SourceTableAttachedPolicy(this, provider.isCompleteHandler.role!);

    // Permissions in the source region
    this.grant(onEventHandlerPolicy, 'dynamodb:*');
    this.grant(isCompleteHandlerPolicy, 'dynamodb:DescribeTable');

    let previousRegion: CustomResource | undefined;
    let previousRegionCondition: CfnCondition | undefined;

    // Replica table's removal policy will default to DynamoDB Table's removal policy
    // unless replica removal policy is specified.
    const retainReplica = FeatureFlags.of(this).isEnabled(DYNAMODB_TABLE_RETAIN_TABLE_REPLICA);

    // If feature flag is disabled, never retain replica to maintain backward compatibility
    const skipReplicaDeletion = retainReplica ? Lazy.any({
      produce: () => {
        // If feature flag is enabled, prioritize replica removal policy
        if (replicaRemovalPolicy) {
          return replicaRemovalPolicy == RemovalPolicy.RETAIN;
        }
        // Otherwise fall back to source table's removal policy
        return (this.node.defaultChild as CfnResource).cfnOptions.deletionPolicy === CfnDeletionPolicy.RETAIN;
      },
    }) : false;

    for (const region of new Set(regions)) { // Remove duplicates
      // Use multiple custom resources because multiple create/delete
      // updates cannot be combined in a single API call.
      const currentRegion = new CustomResource(this, `Replica${region}`, {
        serviceToken: provider.provider.serviceToken,
        resourceType: 'Custom::DynamoDBReplica',
        properties: {
          TableName: this.tableName,
          Region: region,
          ...skipReplicaDeletion && { SkipReplicaDeletion: skipReplicaDeletion },
          SkipReplicationCompletedWait: waitForReplicationToFinish == null
            ? undefined
            // CFN changes Custom Resource properties to strings anyways,
            // so let's do that ourselves to make it clear in the handler this is a string, not a boolean
            : (!waitForReplicationToFinish).toString(),
        },
      });
      currentRegion.node.addDependency(
        onEventHandlerPolicy.policy,
        isCompleteHandlerPolicy.policy,
      );
      this.globalReplicaCustomResources.push(currentRegion);

      // Deploy time check to prevent from creating a replica in the region
      // where this stack is deployed. Only needed for environment agnostic
      // stacks.
      let createReplica: CfnCondition | undefined;
      if (Token.isUnresolved(stack.region)) {
        createReplica = new CfnCondition(this, `StackRegionNotEquals${region}`, {
          expression: Fn.conditionNot(Fn.conditionEquals(region, Aws.REGION)),
        });
        const cfnCustomResource = currentRegion.node.defaultChild as CfnCustomResource;
        cfnCustomResource.cfnOptions.condition = createReplica;
      }

      // Save regional arns for grantXxx() methods
      this.regionalArns.push(stack.formatArn({
        region,
        service: 'dynamodb',
        resource: 'table',
        resourceName: this.tableName,
      }));

      // We need to create/delete regions sequentially because we cannot
      // have multiple table updates at the same time. The `isCompleteHandler`
      // of the provider waits until the replica is in an ACTIVE state.
      if (previousRegion) {
        if (previousRegionCondition) {
          // we can't simply use a Dependency,
          // because the previousRegion is protected by the "different region" Condition,
          // and you can't have Fn::If in DependsOn.
          // Instead, rely on Ref adding a dependency implicitly!
          const previousRegionCfnResource = previousRegion.node.defaultChild as CfnResource;
          const currentRegionCfnResource = currentRegion.node.defaultChild as CfnResource;
          currentRegionCfnResource.addMetadata('DynamoDbReplicationDependency',
            Fn.conditionIf(previousRegionCondition.logicalId, previousRegionCfnResource.ref, Aws.NO_VALUE));
        } else {
          currentRegion.node.addDependency(previousRegion);
        }
      }

      previousRegion = currentRegion;
      previousRegionCondition = createReplica;
    }

    // Permissions in the destination regions (outside of the loop to
    // minimize statements in the policy)
    onEventHandlerPolicy.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:*'],
      resources: this.regionalArns,
    }));
  }

  /**
   * Whether this table has indexes
   */
  protected get hasIndex(): boolean {
    return this.globalSecondaryIndexes.length + this.localSecondaryIndexes.length > 0;
  }

  /**
   * Set up key properties and return the Table encryption property from the
   * user's configuration.
   */
  private parseEncryption(props: TableProps): { sseSpecification: CfnTableProps['sseSpecification']; encryptionKey?: kms.IKey } {
    let encryptionType = props.encryption;

    if (encryptionType != null && props.serverSideEncryption != null) {
      throw new ValidationError('Only one of encryption and serverSideEncryption can be specified, but both were provided', this);
    }

    if (props.serverSideEncryption && props.encryptionKey) {
      throw new ValidationError('encryptionKey cannot be specified when serverSideEncryption is specified. Use encryption instead', this);
    }

    if (encryptionType === undefined) {
      encryptionType = props.encryptionKey != null
        // If there is a configured encryptionKey, the encryption is implicitly CUSTOMER_MANAGED
        ? TableEncryption.CUSTOMER_MANAGED
        // Otherwise, if severSideEncryption is enabled, it's AWS_MANAGED; else undefined (do not set anything)
        : props.serverSideEncryption ? TableEncryption.AWS_MANAGED : undefined;
    }

    if (encryptionType !== TableEncryption.CUSTOMER_MANAGED && props.encryptionKey) {
      throw new ValidationError(`encryptionKey cannot be specified unless encryption is set to TableEncryption.CUSTOMER_MANAGED (it was set to ${encryptionType})`, this);
    }

    if (encryptionType === TableEncryption.CUSTOMER_MANAGED && props.replicationRegions) {
      throw new ValidationError('TableEncryption.CUSTOMER_MANAGED is not supported by DynamoDB Global Tables (where replicationRegions was set)', this);
    }

    switch (encryptionType) {
      case TableEncryption.CUSTOMER_MANAGED:
        const encryptionKey = props.encryptionKey ?? new kms.Key(this, 'Key', {
          description: `Customer-managed key auto-created for encrypting DynamoDB table at ${this.node.path}`,
          enableKeyRotation: true,
        });

        return {
          sseSpecification: { sseEnabled: true, kmsMasterKeyId: encryptionKey.keyArn, sseType: 'KMS' },
          encryptionKey,
        };

      case TableEncryption.AWS_MANAGED:
        // Not specifying "sseType: 'KMS'" here because it would cause phony changes to existing stacks.
        return { sseSpecification: { sseEnabled: true } };

      case TableEncryption.DEFAULT:
        return { sseSpecification: { sseEnabled: false } };

      case undefined:
        // Not specifying "sseEnabled: false" here because it would cause phony changes to existing stacks.
        return { sseSpecification: undefined };

      default:
        throw new ValidationError(`Unexpected 'encryptionType': ${encryptionType}`, this);
    }
  }

  private renderImportSourceSpecification(
    importSource?: ImportSourceSpecification,
  ): CfnTable.ImportSourceSpecificationProperty | undefined {
    if (!importSource) return undefined;

    return {
      ...importSource.inputFormat._render(),
      inputCompressionType: importSource.compressionType,
      s3BucketSource: {
        s3Bucket: importSource.bucket.bucketName,
        s3BucketOwner: importSource.bucketOwner,
        s3KeyPrefix: importSource.keyPrefix,
      },
    };
  }
}

/**
 * Just a convenient way to keep track of both attributes
 */
interface ScalableAttributePair {
  scalableReadAttribute?: ScalableTableAttribute;
  scalableWriteAttribute?: ScalableTableAttribute;
}

/**
 * An inline policy that is logically bound to the source table of a DynamoDB Global Tables
 * "cluster". This is here to ensure permissions are removed as part of (and not before) the
 * CleanUp phase of a stack update, when a replica is removed (or the entire "cluster" gets
 * replaced).
 *
 * If statements are added directly to the handler roles (as opposed to in a separate inline
 * policy resource), new permissions are in effect before clean up happens, and so replicas that
 * need to be dropped can no longer be due to lack of permissions.
 */
class SourceTableAttachedPolicy extends Construct implements iam.IGrantable {
  public readonly grantPrincipal: iam.IPrincipal;
  public readonly policy: iam.IManagedPolicy;

  public constructor(sourceTable: Table, role: iam.IRole) {
    super(sourceTable, `SourceTableAttachedManagedPolicy-${Names.nodeUniqueId(role.node)}`);

    const policy = new iam.ManagedPolicy(this, 'Resource', {
      // A CF update of the description property of a managed policy requires
      // a replacement. Use the table name in the description to force a managed
      // policy replacement when the table name changes. This way we preserve permissions
      // to delete old replicas in case of a table replacement.
      description: `DynamoDB replication managed policy for table ${sourceTable.tableName}`,
      roles: [role],
    });
    this.policy = policy;
    this.grantPrincipal = new SourceTableAttachedPrincipal(role, policy);
  }
}

/**
 * An `IPrincipal` entity that can be used as the target of `grant` calls, used by the
 * `SourceTableAttachedPolicy` class so it can act as an `IGrantable`.
 */
class SourceTableAttachedPrincipal extends iam.PrincipalBase {
  public constructor(private readonly role: iam.IRole, private readonly policy: iam.ManagedPolicy) {
    super();
  }

  public get policyFragment(): iam.PrincipalPolicyFragment {
    return this.role.policyFragment;
  }

  public addToPrincipalPolicy(statement: iam.PolicyStatement): iam.AddToPrincipalPolicyResult {
    this.policy.addStatements(statement);
    return {
      policyDependable: this.policy,
      statementAdded: true,
    };
  }

  public dedupeString(): string | undefined {
    return undefined;
  }
}
