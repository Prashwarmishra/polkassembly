// Copyright 2019-2020 @Premiurly/polkassembly authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

import { ThemeProvider } from '@xstyled/styled-components';
import React from 'react';
import { BrowserRouter as Router } from 'react-router-dom';

import Apollo from './components/Apollo';
import Head from './components/Head';
import Modal from './components/Modal';
import Notifications from './components/Notifications';
import ComponentsContainer from './ComponentsContainer';
import { ApiContextProvider } from './context/ApiContext';
import { MetaProvider } from './context/MetaContext';
import { ModalProvider } from './context/ModalContext';
import { NotificationProvider } from './context/NotificationContext';
import { UserDetailsProvider } from './context/UserDetailsContext';
import { theme } from './themes/theme';
import { GlobalStyle } from './ui-components/GlobalStyle';

const App = () => {
	return (
		<>
			<Router>
				<ThemeProvider theme={theme}>
					<NotificationProvider>
						<ModalProvider>
							<UserDetailsProvider>
								<MetaProvider>
									<Apollo>
										<Head />
										<GlobalStyle />
										<Notifications/>
										<Modal/>
										<ApiContextProvider>
											<ComponentsContainer />
										</ApiContextProvider>
									</Apollo>
								</MetaProvider>
							</UserDetailsProvider>
						</ModalProvider>
					</NotificationProvider>
				</ThemeProvider>
			</Router>
		</>
	);
};

export default App;
