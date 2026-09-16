import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DomainError } from '@rentwell/domain';
import type { SignInInput } from '@rentwell/graphql';
import type { GqlContext } from '../common/context';
import { principal } from '../common/guards';
import { AuthService, type MemberPayload, type ViewerPayload } from './auth.service';

@Resolver('Viewer')
export class AuthResolver {
  constructor(private readonly auth: AuthService) {}

  @Query('viewer')
  async viewer(@Context() ctx: GqlContext): Promise<ViewerPayload | null> {
    // Returns null rather than throwing: the client uses this to decide whether
    // to show the sign-in page, and an error there would be noise.
    if (ctx.access === null) return null;
    return this.auth.viewer(ctx.access);
  }

  @Mutation('signIn')
  async signIn(
    @Args('input') input: SignInInput,
    @Context() ctx: GqlContext,
  ): Promise<{ viewer: ViewerPayload; csrfToken: string }> {
    if (typeof input?.email !== 'string' || typeof input?.password !== 'string') {
      throw new DomainError('VALIDATION_FAILED', 'Email and password are required');
    }

    const session = await this.auth.signIn(
      ctx.req,
      ctx.res,
      input.email,
      input.password,
      ctx.correlationId,
    );

    return {
      viewer: await this.auth.viewer(session.access),
      csrfToken: session.csrfToken,
    };
  }

  @Mutation('signOut')
  async signOut(@Context() ctx: GqlContext): Promise<boolean> {
    const access = principal(ctx);
    if (ctx.sessionId === null) return true;
    await this.auth.signOut(ctx.sessionId, access, ctx.res, ctx.correlationId);
    return true;
  }

  @Query('members')
  async members(@Context() ctx: GqlContext): Promise<MemberPayload[]> {
    // Every signed-in role may see who else is in the organization, because
    // exception assignment and audit trails name people. Only an administrator
    // may change a membership, which is a separate action.
    const access = principal(ctx);
    return this.auth.listMembers(access);
  }
}
