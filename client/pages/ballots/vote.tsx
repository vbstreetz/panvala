import * as React from 'react';
import styled from 'styled-components';
import { toast } from 'react-toastify';
import { utils, Signer } from 'ethers';
import isEmpty from 'lodash/isEmpty';

import { COLORS } from '../../styles';
import { MainContext, IMainContext } from '../../components/MainProvider';
import { EthereumContext, IEthereumContext } from '../../components/EthereumProvider';
import Button from '../../components/Button';
import Card from '../../components/Card';
import CenteredTitle from '../../components/CenteredTitle';
import CenteredWrapper from '../../components/CenteredWrapper';
import Deadline from '../../components/Deadline';
import Image from '../../components/Image';
import Label from '../../components/Label';
import Modal, { ModalTitle, ModalDescription } from '../../components/Modal';
import SectionLabel from '../../components/SectionLabel';
import { ISlate, ISubmitBallot, IChoices } from '../../interfaces';
import {
  randomSalt,
  generateCommitHash,
  generateCommitMessage,
  getMaxVotingRights,
} from '../../utils/voting';
import { postBallot } from '../../utils/api';
import { handleGenericError, ETHEREUM_NOT_AVAILABLE } from '../../utils/errors';
import { isBallotOpen, convertEVMSlateStatus, SlateStatus } from '../../utils/status';
import Actions from '../../components/Actions';
import { loadState, LINKED_WALLETS } from '../../utils/localStorage';
import { SLATE } from '../../utils/constants';
import RouterLink from '../../components/RouterLink';
import PendingTransaction from '../../components/PendingTransaction';
import Box from '../../components/system/Box';
import Flex from '../../components/system/Flex';
import ClosedBallot from '../../components/ClosedBallot';

const Separator = styled.div`
  border: 1px solid ${COLORS.grey5};
`;

type ISectionProps = {
  title: string;
  slates: ISlate[];
  choices: IChoices;
  onSetChoice: any;
};

const BallotSection: React.FunctionComponent<ISectionProps> = ({
  title,
  slates,
  choices,
  onSetChoice,
}) => {
  const subtitle = (slate: ISlate) => {
    if (slate.category === 'GRANT') {
      return slate.proposals ? `${slate.proposals.length} Grants included` : '';
    }
    return '';
  };

  const filtered = slates.filter(s => s.status === SlateStatus.Staked);

  // TODO: if length == 1, show the slate, but disable vote buttons (no contest / auto-win)
  if (filtered.length < 2) {
    return <></>;
  }

  return (
    <Box p={4}>
      <SectionLabel>{title}</SectionLabel>
      <Label required>{'Select your first and second choice slate'}</Label>
      <Flex wrap="true" mt={3}>
        {filtered.length > 0
          ? filtered.map((slate: ISlate) => (
              <Card
                key={slate.id}
                subtitle={subtitle(slate)}
                description={slate.description}
                category={slate.category}
                status={convertEVMSlateStatus(slate.status)}
                choices={choices}
                address={slate.recommender}
                onSetChoice={onSetChoice}
                proposals={slate.proposals}
                slateID={slate.id.toString()}
                asPath={'/ballots/vote'}
                type={SLATE}
                incumbent={slate.incumbent}
                recommender={slate.organization}
                verifiedRecommender={slate.verifiedRecommender}
                width={['98%', '98%', '98%', '46%']}
              />
            ))
          : null}
      </Flex>
    </Box>
  );
};

const Vote: React.FC = () => {
  // get contexts
  const { slates, currentBallot }: IMainContext = React.useContext(MainContext);
  const {
    contracts: { token, gatekeeper, tokenCapacitor, parameterStore },
    account,
    panBalance,
    gkAllowance,
    votingRights,
    ethProvider,
  }: IEthereumContext = React.useContext(EthereumContext);

  // component state
  // choice selector - at the start, the user has not made any choices
  const [choices, setChoice]: [IChoices, any] = React.useState({});

  // generate random salt on-load
  const [salt]: [string, any] = React.useState(randomSalt().toString());
  // modal opener
  const [isOpen, setOpenModal] = React.useState(false);
  const [txPending, setTxPending] = React.useState(false);

  // (GRANT | GOVERNANCE) => [slates]
  const availableSlates = {};
  slates.forEach(s => {
    if (typeof availableSlates[s.category] === 'undefined') {
      availableSlates[s.category] = [s];
    } else {
      availableSlates[s.category].push(s);
    }
  });

  const [grantSlates] = React.useState(availableSlates['GRANT'] || []);
  const [governanceSlates] = React.useState(availableSlates['GOVERNANCE'] || []);

  // Temp: log the choices
  React.useEffect(() => {
    console.log('choices', choices);
  }, [choices]);

  /**
   * Click handler for choosing which rank (first/second) a slate has
   * @param category the category to set for: GRANT | GOVERNANCE
   * @param rank key to specify which choice to set
   * @param slateID id of slate choice
   */
  function handleSetChoice(category: 'GRANT' | 'GOVERNANCE', rank: string, slateID: string) {
    const currentChoice = choices[category] || {};

    if (
      (rank === 'firstChoice' && currentChoice.secondChoice === slateID) ||
      (rank === 'secondChoice' && currentChoice.firstChoice === slateID)
    ) {
      // user chose a different rank for a slate
      setChoice({
        ...choices,
        [category]: { [rank]: slateID },
      });
    } else {
      // user chose a unique rank for a slate
      setChoice({
        ...choices,
        [category]: {
          ...currentChoice,
          [rank]: slateID,
        },
      });
    }
  }

  // TODO: move this somewhere better
  function categoryToResource(category: string): string {
    if (category === 'GRANT') {
      return tokenCapacitor.address;
    } else {
      return parameterStore.address;
    }
  }

  /**
   * Click handler for submitting/committing a vote
   */
  async function handleSubmitVote() {
    // enforce both first and second choices for each category
    try {
      Object.keys(choices).forEach(category => {
        const contest = choices[category];
        if (contest.firstChoice === '' || typeof contest.firstChoice === 'undefined') {
          toast.error(`Must select a first choice for ${category}`);
          throw new Error(`Must select a first choice for ${category}`);
        }

        if (contest.secondChoice === '' || typeof contest.secondChoice === 'undefined') {
          toast.error(`Must select a second choice for ${category}`);
          throw new Error(`Must select a second choice for ${category}`);
        }
      });
    } catch (error) {
      return;
    }

    setTxPending(true);

    // prepare and submit the ballot choices
    try {
      // Put choices in the format to submit
      const submitChoices = {};
      Object.keys(choices).forEach(category => {
        const choice = choices[category];
        const resource = categoryToResource(category);
        submitChoices[resource] = {
          firstChoice: utils.bigNumberify(choice.firstChoice).toString(),
          secondChoice: utils.bigNumberify(choice.secondChoice).toString(),
        };
      });
      console.log('choices to submit', submitChoices);

      if (account && !isEmpty(token) && !isEmpty(ethProvider)) {
        let numTokens = await getMaxVotingRights(
          panBalance,
          votingRights,
          gkAllowance,
          token,
          gatekeeper
        );

        let tokenHolder = account;
        const linkedWallets = loadState(LINKED_WALLETS);
        if (!!linkedWallets && !!linkedWallets.coldWallet) {
          const delegate = await gatekeeper.functions.delegate(linkedWallets.coldWallet);
          if (delegate === account) {
            tokenHolder = linkedWallets.coldWallet;
            // prettier-ignore
            numTokens = await gatekeeper.functions.voteTokenBalance(tokenHolder);
          }
        }
        console.log('numTokens:', numTokens);

        // TODO: check that the token holder has not already committed and throw if they have
        // No need to go through all the rest if they have

        const ballot: ISubmitBallot = {
          epochNumber: currentBallot.epochNumber.toString(),
          choices: submitChoices,
          salt,
          voterAddress: tokenHolder,
          ...(tokenHolder !== account && { delegate: account }),
        };
        console.log('ballot:', ballot);

        // Token holder has tokens, so submit the ballot
        if (numTokens.gt('0')) {
          const commitHash: string = generateCommitHash(ballot.choices, salt);

          // 'Commit hash, first choice, second choice, salt'
          const message = generateCommitMessage(commitHash, ballot.choices, salt);

          // sign message with metamask signer
          const signer: Signer = ethProvider.getSigner();
          const signature = await signer.signMessage(message);

          // save ballot to api/db
          const res = await postBallot(ballot, commitHash, signature);

          if (res.status === 200) {
            // estimate how much it's gonna cost (gasLimit)
            const estimate = await gatekeeper.estimate.commitBallot(
              tokenHolder,
              commitHash,
              numTokens
            );
            // commit (vote) the ballot to the gatekeeper contract
            // custom gasLimit can be provided here
            // -> gasPrice needs to be set also -- otherwise it will send with 1.0 gwei gas, which is not fast enough
            const txOptions = {
              gasLimit: estimate.add('70000').toHexString(), // for safety, +70k gas (+20k doesn't cut it)
              gasPrice: utils.parseUnits('9.0', 'gwei'),
            };
            await gatekeeper.functions.commitBallot(tokenHolder, commitHash, numTokens, txOptions);

            setTxPending(false);
            setOpenModal(true);
            toast.success('Successfully submitted a ballot');
          } else {
            console.error('Problem preparing ballot');
            throw new Error('Problem preparing ballot');
          }
        } else {
          // no tokens to vote with
          throw new Error(`Token holder ${tokenHolder} has no tokens available for voting`);
        }
      } else {
        throw new Error(ETHEREUM_NOT_AVAILABLE);
      }
    } catch (error) {
      handleSubmissionError(error);
    }
  }

  function handleSubmissionError(error: Error) {
    // Reset the view
    setTxPending(false);
    setOpenModal(false);

    // interpret the error and display a toast if appropriate
    const errorType = handleGenericError(error, toast);
    if (errorType) {
      // Failed to approve
      // Failed to delegate
      // Token holder has no tokens
      // Token holder has already committed fo this epoch
      // Failed to save ballot
      // Failed to commit ballot
      toast.error(`Problem submitting ballot: ${error.message}`);
    }

    if (votingRights.gt('0') && panBalance.eq('0')) {
      const info =
        'Entire balance is being used as votingRights, and they may currently be locked in a vote.';
      toast.info(info);
    }

    console.error(error);
  }

  if (!isBallotOpen(currentBallot)) {
    return <ClosedBallot currentBallot={currentBallot} />;
  }

  return (
    <>
      <Modal handleClick={() => setOpenModal(false)} isOpen={isOpen}>
        <Image src="/static/check.svg" alt="vote submitted" width="80px" />
        <ModalTitle>{'Vote submitted.'}</ModalTitle>
        <ModalDescription>
          Your vote has been recorded. It won't be revealed publicly until the vote concludes.
        </ModalDescription>
        <RouterLink href="/ballots" as="/ballots">
          <Button type="default">{'Done'}</Button>
        </RouterLink>
      </Modal>

      <Flex justifyEnd>
        <Deadline ballot={currentBallot} route="ballots" />
      </Flex>
      <CenteredTitle title="Submit Vote" />
      <CenteredWrapper>
        {grantSlates.length > 0 ? (
          <BallotSection
            title={'GRANTS'}
            slates={grantSlates}
            choices={choices}
            onSetChoice={handleSetChoice}
          />
        ) : null}

        {governanceSlates.length > 0 ? (
          <BallotSection
            title={'GOVERNANCE'}
            slates={governanceSlates}
            choices={choices}
            onSetChoice={handleSetChoice}
          />
        ) : null}

        <Separator />
        <Actions handleClick={handleSubmitVote} actionText={'Confirm and Submit'} />
      </CenteredWrapper>

      <PendingTransaction isOpen={txPending} setOpen={setTxPending} />
    </>
  );
};

export default Vote;
