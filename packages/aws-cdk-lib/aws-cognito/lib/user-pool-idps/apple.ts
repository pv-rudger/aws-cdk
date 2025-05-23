import { Construct } from 'constructs';
import { UserPoolIdentityProviderProps } from './base';
import { CfnUserPoolIdentityProvider } from '../cognito.generated';
import { UserPoolIdentityProviderBase } from './private/user-pool-idp-base';
import { SecretValue } from '../../../core';
import { ValidationError } from '../../../core/lib/errors';
import { addConstructMetadata } from '../../../core/lib/metadata-resource';
import { propertyInjectable } from '../../../core/lib/prop-injectable';

/**
 * Properties to initialize UserPoolAppleIdentityProvider
 */
export interface UserPoolIdentityProviderAppleProps extends UserPoolIdentityProviderProps {
  /**
   * The client id recognized by Apple APIs.
   * @see https://developer.apple.com/documentation/sign_in_with_apple/clientconfigi/3230948-clientid
   */
  readonly clientId: string;
  /**
   * The teamId for Apple APIs to authenticate the client.
   */
  readonly teamId: string;
  /**
   * The keyId (of the same key, which content has to be later supplied as `privateKey`) for Apple APIs to authenticate the client.
   */
  readonly keyId: string;
  /**
   * The privateKey content for Apple APIs to authenticate the client.
   *
   * @deprecated use privateKeyValue
   * @default none
   */
  readonly privateKey?: string;
  /**
   * The privateKey content for Apple APIs to authenticate the client.
   * @default none
   */
  readonly privateKeyValue?: SecretValue;
  /**
   * The list of apple permissions to obtain for getting access to the apple profile
   * @see https://developer.apple.com/documentation/sign_in_with_apple/clientconfigi/3230955-scope
   * @default [ name ]
   */
  readonly scopes?: string[];
}

/**
 * Represents an identity provider that integrates with Apple
 * @resource AWS::Cognito::UserPoolIdentityProvider
 */
@propertyInjectable
export class UserPoolIdentityProviderApple extends UserPoolIdentityProviderBase {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-cognito.UserPoolIdentityProviderApple';
  public readonly providerName: string;

  constructor(scope: Construct, id: string, props: UserPoolIdentityProviderAppleProps) {
    super(scope, id, props);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    const scopes = props.scopes ?? ['name'];

    // Exactly one of the properties must be configured
    if ((!props.privateKey && !props.privateKeyValue) ||
      (props.privateKey && props.privateKeyValue)) {
      throw new ValidationError('Exactly one of "privateKey" or "privateKeyValue" must be configured.', this);
    }

    const resource = new CfnUserPoolIdentityProvider(this, 'Resource', {
      userPoolId: props.userPool.userPoolId,
      providerName: 'SignInWithApple', // must be 'SignInWithApple' when the type is 'SignInWithApple'
      providerType: 'SignInWithApple',
      providerDetails: {
        client_id: props.clientId,
        team_id: props.teamId,
        key_id: props.keyId,
        private_key: props.privateKeyValue ? props.privateKeyValue.unsafeUnwrap() : props.privateKey,
        authorize_scopes: scopes.join(' '),
      },
      attributeMapping: super.configureAttributeMapping(),
    });

    this.providerName = super.getResourceNameAttribute(resource.ref);
  }
}
